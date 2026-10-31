import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/ids.js';
import { createWallet, postWager, request, wagerBody } from '../support/api.js';
import { type TestApp, startApp } from '../support/app.js';
import { expectReconciled, ledgerCount, sql } from '../support/database.js';

let app: TestApp;

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  await app.close();
});

describe('POST /wallets', () => {
  it('creates the wallet with an OPENING credit in the same transaction', async () => {
    const playerId = newId();

    const response = await request(app.baseUrl, 'POST', '/wallets', {
      body: {
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      },
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const walletId = response.body.id;
    expect(await ledgerCount(walletId, 'CREDIT')).toBe(1);
    const [opening] = await sql<{ kind: string; status: string }>(
      'select kind, status from wager_transactions where wallet_id = ?',
      [walletId],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });
    await expectReconciled(walletId);
  });

  it('creates a zero-balance wallet without ledger entries', async () => {
    const wallet = await createWallet(app.baseUrl, '0.00');

    expect(await ledgerCount(wallet.id)).toBe(0);
    await expectReconciled(wallet.id);
  });

  it('refuses a second wallet for the same player and currency', async () => {
    const wallet = await createWallet(app.baseUrl, '10.00');

    const duplicate = await request(app.baseUrl, 'POST', '/wallets', {
      body: {
        playerId: wallet.playerId,
        initialBalance: { amount: '5.00', currency: 'BRL' },
      },
    });
    const otherCurrency = await request(app.baseUrl, 'POST', '/wallets', {
      body: {
        playerId: wallet.playerId,
        initialBalance: { amount: '5.00', currency: 'USD' },
      },
    });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('WALLET_ALREADY_EXISTS');
    expect(otherCurrency.status).toBe(201);
  });

  it.each([
    [
      {
        playerId: 'not-a-uuid',
        initialBalance: { amount: '1.00', currency: 'BRL' },
      },
    ],
    [{ playerId: newId(), initialBalance: { amount: 10, currency: 'BRL' } }],
    [
      {
        playerId: newId(),
        initialBalance: { amount: '-1.00', currency: 'BRL' },
      },
    ],
    [
      {
        playerId: newId(),
        initialBalance: { amount: '1.001', currency: 'BRL' },
      },
    ],
    [{ playerId: newId(), initialBalance: { amount: '1e3', currency: 'BRL' } }],
    [{ playerId: newId() }],
  ])('rejects invalid payload %#', async (body) => {
    const response = await request(app.baseUrl, 'POST', '/wallets', { body });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await fetch(`${app.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"playerId":',
    });

    expect(response.status).toBe(400);
  });
});

describe('GET /wallets/:walletId', () => {
  it('returns the wallet', async () => {
    const wallet = await createWallet(app.baseUrl, '42.00');

    const response = await request(app.baseUrl, 'GET', `/wallets/${wallet.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: wallet.id,
      balance: { amount: '42.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('distinguishes not found from invalid ids', async () => {
    expect(
      (await request(app.baseUrl, 'GET', `/wallets/${newId()}`)).status,
    ).toBe(404);
    expect((await request(app.baseUrl, 'GET', '/wallets/123')).status).toBe(
      400,
    );
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  it('pages with a stable opaque cursor', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    for (const amount of ['1.00', '2.00', '3.00', '4.00']) {
      expect(
        (await postWager(app.baseUrl, wagerBody(wallet, 'BET', amount))).status,
      ).toBe(201);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = await request(
        app.baseUrl,
        'GET',
        `/wallets/${wallet.id}/ledger${query}`,
      );
      expect(page.status).toBe(200);
      seen.push(
        ...page.body.items.map(
          (item: { money: { amount: string } }) => item.money.amount,
        ),
      );
      cursor = page.body.nextCursor;
    } while (cursor);

    expect(seen).toEqual(['100.00', '1.00', '2.00', '3.00', '4.00']);
  });

  it('rejects tampered cursors and limits', async () => {
    const wallet = await createWallet(app.baseUrl, '1.00');

    const badCursor = await request(
      app.baseUrl,
      'GET',
      `/wallets/${wallet.id}/ledger?cursor=abc`,
    );
    const badLimit = await request(
      app.baseUrl,
      'GET',
      `/wallets/${wallet.id}/ledger?limit=0`,
    );

    expect(badCursor.status).toBe(400);
    expect(badLimit.status).toBe(400);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('confirms a consistent wallet', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    await postWager(app.baseUrl, wagerBody(wallet, 'BET', '30.00'));
    await postWager(app.baseUrl, wagerBody(wallet, 'WIN', '5.50'));

    const response = await request(
      app.baseUrl,
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '75.50', currency: 'BRL' },
      calculatedBalance: { amount: '75.50', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  it('flags a divergence without fixing it', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    await sql('update wallets set balance = 90 where id = ?', [wallet.id]);

    const response = await request(
      app.baseUrl,
      'POST',
      `/wallets/${wallet.id}/reconciliation`,
    );
    const metrics = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());

    expect(response.body).toMatchObject({
      consistent: false,
      storedBalance: { amount: '90.00' },
      calculatedBalance: { amount: '100.00' },
      difference: { amount: '-10.00' },
    });
    expect(
      (await request(app.baseUrl, 'GET', `/wallets/${wallet.id}`)).body.balance
        .amount,
    ).toBe('90.00');
    expect(metrics).toMatch(/reconciliation_mismatches_total [1-9]/);
  });
});
