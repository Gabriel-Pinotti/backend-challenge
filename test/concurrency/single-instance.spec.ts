import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/ids.js';
import {
  createWallet,
  postWager,
  type TestWallet,
  wagerBody,
  waitFor,
} from '../support/api.js';
import { type TestApp, startApp } from '../support/app.js';
import {
  balanceOf,
  expectReconciled,
  ledgerCount,
  sql,
} from '../support/database.js';

let app: TestApp;

beforeAll(async () => {
  app = await startApp((config) => {
    config.pendingReferences.enabled = true;
  });
});

afterAll(async () => {
  await app.close();
});

const statuses = (responses: { status: number }[]) =>
  responses.map((response) => response.status).sort((a, b) => a - b);

describe('concurrency on a single instance', () => {
  it('the same bet sent 50 times in parallel debits once', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    const body = wagerBody(wallet, 'BET', '10.00');

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => postWager(app.baseUrl, body)),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(49);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.every((r) => r.body.balance.amount === '90.00')).toBe(
      true,
    );
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await expectReconciled(wallet.id);
  });

  it('100.00 against two simultaneous 80.00 bets keeps exactly one', async () => {
    for (let round = 0; round < 5; round++) {
      const wallet = await createWallet(app.baseUrl, '100.00');

      const responses = await Promise.all([
        postWager(app.baseUrl, wagerBody(wallet, 'BET', '80.00')),
        postWager(app.baseUrl, wagerBody(wallet, 'BET', '80.00')),
      ]);

      expect(statuses(responses)).toEqual([201, 422]);
      expect(responses.find((r) => r.status === 422)?.body.failureCode).toBe(
        'INSUFFICIENT_FUNDS',
      );
      expect(await balanceOf(wallet.id)).toBe('20.00');
      expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
      await expectReconciled(wallet.id);
    }
  });

  it('a hot wallet never overspends', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');

    const responses = await Promise.all(
      Array.from({ length: 30 }, () =>
        postWager(app.baseUrl, wagerBody(wallet, 'BET', '10.00')),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(10);
    expect(responses.filter((r) => r.status === 422)).toHaveLength(20);
    expect(await balanceOf(wallet.id)).toBe('0.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(10);
    await expectReconciled(wallet.id);
  });

  it('different wallets are processed in parallel', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 20 }, () => createWallet(app.baseUrl, '50.00')),
    );

    const responses = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, () =>
          postWager(app.baseUrl, wagerBody(wallet, 'BET', '10.00')),
        ),
      ),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    for (const wallet of wallets) {
      expect(await balanceOf(wallet.id)).toBe('0.00');
      await expectReconciled(wallet.id);
    }
  });

  it('REFUND and ROLLBACK delivered before their BET revert it exactly once', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    const betId = `tx-${newId()}`;
    const reversal = (kind: string) =>
      wagerBody(wallet, kind, '30.00', {
        referenceExternalTransactionId: betId,
      });

    const early = await Promise.all([
      postWager(app.baseUrl, reversal('REFUND')),
      postWager(app.baseUrl, reversal('ROLLBACK')),
    ]);
    expect(early.map((r) => r.status)).toEqual([202, 202]);

    const bet = await postWager(
      app.baseUrl,
      wagerBody(wallet, 'BET', '30.00', { externalTransactionId: betId }),
    );
    expect(bet.status).toBe(201);

    const settled = await waitFor(
      () =>
        sql<{ kind: string; status: string; failure_code: string | null }>(
          "select kind, status, failure_code from wager_transactions where wallet_id = ? and kind in ('REFUND', 'ROLLBACK')",
          [wallet.id],
        ),
      (rows) => rows.every((row) => row.status !== 'PENDING_REFERENCE'),
    );

    expect(settled.filter((row) => row.status === 'PROCESSED')).toHaveLength(1);
    expect(settled.find((row) => row.status === 'REJECTED')?.failure_code).toBe(
      'ALREADY_REVERSED',
    );
    expect(await balanceOf(wallet.id)).toBe('100.00');
    await expectReconciled(wallet.id);
  });

  it('mixed concurrent traffic keeps every wallet reconciled', async () => {
    const wallets: TestWallet[] = await Promise.all(
      Array.from({ length: 5 }, () => createWallet(app.baseUrl, '200.00')),
    );
    const bodies = wallets.flatMap((wallet) => [
      ...Array.from({ length: 8 }, () => wagerBody(wallet, 'BET', '20.00')),
      ...Array.from({ length: 4 }, () => wagerBody(wallet, 'WIN', '5.00')),
    ]);

    await Promise.all(
      [...bodies, ...bodies].map((body) => postWager(app.baseUrl, body)),
    );

    for (const wallet of wallets) {
      await expectReconciled(wallet.id);
      expect(await ledgerCount(wallet.id)).toBe(1 + 8 + 4);
    }
  });
});
