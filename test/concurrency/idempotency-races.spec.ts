import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createWallet, postWager, wagerBody } from '../support/api.js';
import { type TestApp, startApp } from '../support/app.js';
import { expectReconciled, ledgerCount, sql } from '../support/database.js';

let app: TestApp;

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  await app.close();
});

describe('idempotency races across wallets', () => {
  it('the same key fired at different wallets at once is applied to exactly one', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 6 }, () => createWallet(app.baseUrl, '100.00')),
    );
    const key = `race:${crypto.randomUUID()}`;

    const responses = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 3 }, () =>
          postWager(
            app.baseUrl,
            wagerBody(wallet, 'BET', '10.00', { externalTransactionId: key }),
            key,
          ),
        ),
      ),
    );

    const statuses = responses.map((response) => response.status);
    expect(statuses.every((status) => [200, 201, 409].includes(status))).toBe(
      true,
    );
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    const debited = await Promise.all(
      wallets.map((wallet) => ledgerCount(wallet.id, 'DEBIT')),
    );
    expect(debited.reduce((sum, count) => sum + count, 0)).toBe(1);
    const [stored] = await sql<{ count: number }>(
      'select count(*)::int as count from wager_transactions where idempotency_key = ?',
      [key],
    );
    expect(stored?.count).toBe(1);
    for (const wallet of wallets) {
      await expectReconciled(wallet.id);
    }
  });

  it('the same external id under different keys at once is applied once', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    const body = wagerBody(wallet, 'BET', '10.00');

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        postWager(app.baseUrl, body, `key-${i}-${body.externalTransactionId}`),
      ),
    );

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(9);
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await expectReconciled(wallet.id);
  });
});
