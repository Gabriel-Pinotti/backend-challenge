import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ResolvePendingReferencesUseCase } from '../../src/application/resolve-pending-references.use-case.js';
import { newId } from '../../src/domain/ids.js';
import mikroOrmConfig from '../../src/mikro-orm.config.js';
import {
  createWallet,
  keyOf,
  postWager,
  request,
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
    config.database.lockTimeoutMs = 300;
  });
});

afterAll(async () => {
  await app.close();
});

async function eventTypes(walletId: string): Promise<string[]> {
  const rows = await sql<{ event_type: string }>(
    'select event_type from outbox_messages where aggregate_id = ? order by occurred_at, event_type',
    [walletId],
  );
  return rows.map((row) => row.event_type);
}

async function processed(
  wallet: TestWallet,
  kind: string,
  amount: string,
  overrides = {},
) {
  const body = wagerBody(wallet, kind, amount, overrides);
  const response = await postWager(app.baseUrl, body);
  expect(response.status).toBe(201);
  return body;
}

describe('POST /wagering/transactions', () => {
  it('processes a BET and returns the documented contract', async () => {
    const wallet = await createWallet(app.baseUrl, '1000.00');

    const response = await postWager(
      app.baseUrl,
      wagerBody(wallet, 'BET', '25.00'),
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await eventTypes(wallet.id)).toContain('WalletBalanceChanged');
    await expectReconciled(wallet.id);
  });

  describe('idempotency', () => {
    it('replays the original result, including the balance observed back then', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const first = wagerBody(wallet, 'BET', '10.00');
      const original = await postWager(app.baseUrl, first);
      await processed(wallet, 'BET', '20.00');

      const replay = await postWager(app.baseUrl, first);

      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
      expect(replay.body.balance.amount).toBe('90.00');
      expect(await balanceOf(wallet.id)).toBe('70.00');
      expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(2);
    });

    it('treats the same key with a different payload as a conflict', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const body = wagerBody(wallet, 'BET', '10.00');
      await postWager(app.baseUrl, body);

      const conflict = await postWager(
        app.baseUrl,
        { ...body, money: { amount: '11.00', currency: 'BRL' } },
        keyOf(body),
      );

      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balanceOf(wallet.id)).toBe('90.00');
    });

    it('rejects the same external transaction under another key', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const body = wagerBody(wallet, 'BET', '10.00');
      await postWager(app.baseUrl, body);

      const response = await postWager(app.baseUrl, body, 'another-key');

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('EXTERNAL_TRANSACTION_ID_REUSED');
    });

    it('replays rejections with the same failure code', async () => {
      const wallet = await createWallet(app.baseUrl, '5.00');
      const body = wagerBody(wallet, 'BET', '10.00');

      const first = await postWager(app.baseUrl, body);
      const second = await postWager(app.baseUrl, body);

      expect(first.status).toBe(422);
      expect(second.status).toBe(422);
      expect(second.body).toEqual({ ...first.body, idempotentReplay: true });
      expect(second.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    });

    it('requires the Idempotency-Key header', async () => {
      const wallet = await createWallet(app.baseUrl, '5.00');

      const response = await request(
        app.baseUrl,
        'POST',
        '/wagering/transactions',
        {
          body: wagerBody(wallet, 'BET', '1.00'),
        },
      );

      expect(response.status).toBe(400);
      expect(response.body.details[0].path).toBe('Idempotency-Key');
    });
  });

  describe('validation', () => {
    it.each([
      ['OPENING kind', { kind: 'OPENING' }],
      ['unknown kind', { kind: 'JACKPOT' }],
      ['float amount', { money: { amount: 10, currency: 'BRL' } }],
      ['three decimals', { money: { amount: '1.005', currency: 'BRL' } }],
      ['negative amount', { money: { amount: '-1.00', currency: 'BRL' } }],
      ['REFUND without reference', { kind: 'REFUND' }],
      ['BET with reference', { referenceExternalTransactionId: 'x' }],
      ['reserved provider', { providerId: 'internal' }],
      ['bad wallet id', { walletId: 'nope' }],
    ])('rejects %s with 400', async (_, override) => {
      const wallet = await createWallet(app.baseUrl, '5.00');
      const body = { ...wagerBody(wallet, 'BET', '1.00'), ...override };

      const response = await postWager(
        app.baseUrl,
        body as never,
        `key-${newId()}`,
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('business rules', () => {
    it('WIN credits and LOSS records without moving the balance', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const bet = await processed(wallet, 'BET', '10.00');

      const win = await postWager(
        app.baseUrl,
        wagerBody(wallet, 'WIN', '30.00', {
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );
      const loss = await postWager(
        app.baseUrl,
        wagerBody(wallet, 'LOSS', '10.00', {
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      );

      expect(win.status).toBe(201);
      expect(win.body.balance.amount).toBe('120.00');
      expect(loss.status).toBe(201);
      expect(loss.body.balance.amount).toBe('120.00');
      expect(await ledgerCount(wallet.id)).toBe(3);
      expect(await eventTypes(wallet.id)).toEqual(
        expect.arrayContaining([
          'WagerTransactionProcessed',
          'WalletBalanceChanged',
        ]),
      );
      await expectReconciled(wallet.id);
    });

    it('REFUND reverts a BET only once', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const bet = await processed(wallet, 'BET', '40.00');
      const refund = (externalTransactionId = `tx-${newId()}`) =>
        wagerBody(wallet, 'REFUND', '40.00', {
          externalTransactionId,
          referenceExternalTransactionId: bet.externalTransactionId,
        });

      const first = await postWager(app.baseUrl, refund());
      const second = await postWager(app.baseUrl, refund());

      expect(first.status).toBe(201);
      expect(second.status).toBe(422);
      expect(second.body.failureCode).toBe('ALREADY_REVERSED');
      expect(await balanceOf(wallet.id)).toBe('100.00');
      await expectReconciled(wallet.id);
    });

    it('ROLLBACK of a WIN that would go negative is rejected and auditable', async () => {
      const wallet = await createWallet(app.baseUrl, '50.00');
      const bet = await processed(wallet, 'BET', '50.00');
      const win = await processed(wallet, 'WIN', '50.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      await processed(wallet, 'BET', '50.00', { roundId: 'round-2' });

      const rollback = await postWager(
        app.baseUrl,
        wagerBody(wallet, 'ROLLBACK', '50.00', {
          referenceExternalTransactionId: win.externalTransactionId,
        }),
      );

      expect(rollback.status).toBe(422);
      expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
      const stored = await request(
        app.baseUrl,
        'GET',
        `/wagering/transactions/${rollback.body.transactionId}`,
      );
      expect(stored.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      });
      expect(await eventTypes(wallet.id)).toContain('WagerTransactionRejected');
      await expectReconciled(wallet.id);
    });

    it('rejects currency conflicts and unknown wallets', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const stranger = { id: wallet.id, playerId: newId() };

      const usd = await postWager(
        app.baseUrl,
        wagerBody(wallet, 'BET', '1.00', {
          money: { amount: '1.00', currency: 'USD' },
        }),
      );
      const missing = await postWager(
        app.baseUrl,
        wagerBody({ id: newId(), playerId: wallet.playerId }, 'BET', '1.00'),
      );
      const otherPlayer = await postWager(
        app.baseUrl,
        wagerBody(stranger, 'BET', '1.00'),
      );

      expect(usd.status).toBe(422);
      expect(usd.body.failureCode).toBe('CURRENCY_MISMATCH');
      expect(usd.body.balance).toBeNull();
      expect(missing.status).toBe(422);
      expect(missing.body.failureCode).toBe('WALLET_NOT_FOUND');
      expect(otherPlayer.body.failureCode).toBe('WALLET_NOT_FOUND');
      expect(await balanceOf(wallet.id)).toBe('100.00');
    });

    it('replays every kind of rejection exactly as first answered', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const bodies = [
        wagerBody(wallet, 'BET', '1.00', {
          money: { amount: '1.00', currency: 'USD' },
        }),
        wagerBody({ id: newId(), playerId: wallet.playerId }, 'BET', '1.00'),
        wagerBody({ id: wallet.id, playerId: newId() }, 'BET', '1.00'),
      ];

      for (const body of bodies) {
        const first = await postWager(app.baseUrl, body);
        const replay = await postWager(app.baseUrl, body);
        const lookup = await request(
          app.baseUrl,
          'GET',
          `/wagering/transactions/${first.body.transactionId}`,
        );

        expect(first.status).toBe(422);
        expect(first.body.transactionId).toEqual(expect.any(String));
        expect(replay.status).toBe(422);
        expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
        expect(lookup.body.balance).toEqual(first.body.balance);
      }
    });

    it('refuses to reuse the key of a WALLET_NOT_FOUND rejection for another payload', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const wrongWallet = wagerBody(
        { id: newId(), playerId: wallet.playerId },
        'BET',
        '10.00',
      );
      await postWager(app.baseUrl, wrongWallet);

      const corrected = await postWager(
        app.baseUrl,
        { ...wrongWallet, walletId: wallet.id },
        keyOf(wrongWallet),
      );

      expect(corrected.status).toBe(409);
      expect(corrected.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await balanceOf(wallet.id)).toBe('100.00');
      expect(await eventTypes(wrongWallet.walletId)).toEqual([
        'WagerTransactionRejected',
      ]);
    });
  });

  describe('out-of-order references', () => {
    it('keeps the reversal pending until the BET arrives, then applies it', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const betId = `tx-${newId()}`;
      const refundBody = wagerBody(wallet, 'REFUND', '25.00', {
        referenceExternalTransactionId: betId,
      });

      const early = await postWager(app.baseUrl, refundBody);
      expect(early.status).toBe(202);
      expect(early.body.status).toBe('PENDING_REFERENCE');
      expect(await eventTypes(wallet.id)).toContain(
        'WagerTransactionPendingReference',
      );

      await processed(wallet, 'BET', '25.00', { externalTransactionId: betId });
      const resolver = app.app.get(ResolvePendingReferencesUseCase);
      const settled = await waitFor(
        async () => {
          await resolver.runOnce(50);
          return (await postWager(app.baseUrl, refundBody)).body;
        },
        (body) => body.status === 'PROCESSED',
      );

      expect(settled.balance.amount).toBe('100.00');
      expect(await ledgerCount(wallet.id)).toBe(3);
      await expectReconciled(wallet.id);
    });

    it('gives up after the retry limit with REFERENCE_NOT_FOUND', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const body = wagerBody(wallet, 'ROLLBACK', '10.00', {
        referenceExternalTransactionId: 'never-arrives',
      });
      await postWager(app.baseUrl, body);
      const resolver = app.app.get(ResolvePendingReferencesUseCase);

      const final = await waitFor(
        async () => {
          await resolver.runOnce(50);
          return (await postWager(app.baseUrl, body)).body;
        },
        (result) => result.status === 'REJECTED',
      );

      expect(final.failureCode).toBe('REFERENCE_NOT_FOUND');
      expect(await eventTypes(wallet.id)).toContain('WagerTransactionRejected');
      expect(await balanceOf(wallet.id)).toBe('100.00');
    });
  });

  describe('lookups', () => {
    it('finds a transaction by internal and by provider id', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const body = wagerBody(wallet, 'BET', '1.00');
      const created = await postWager(app.baseUrl, body);

      const byId = await request(
        app.baseUrl,
        'GET',
        `/wagering/transactions/${created.body.transactionId}`,
      );
      const byExternal = await request(
        app.baseUrl,
        'GET',
        `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
      );

      expect(byId.status).toBe(200);
      expect(byExternal.body).toEqual(byId.body);
      expect(byId.body).toMatchObject({
        kind: 'BET',
        status: 'PROCESSED',
        money: { amount: '1.00', currency: 'BRL' },
      });
      expect(
        (await request(app.baseUrl, 'GET', `/wagering/transactions/${newId()}`))
          .status,
      ).toBe(404);
    });
  });

  it('answers 503 with Retry-After when the wallet lock cannot be acquired', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    const holder = await MikroORM.init({ ...mikroOrmConfig, debug: false });
    try {
      const response = await holder.em.fork().transactional(async (em) => {
        await em.execute('select id from wallets where id = ? for update', [
          wallet.id,
        ]);
        return postWager(app.baseUrl, wagerBody(wallet, 'BET', '1.00'));
      });

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('TRANSIENT_ERROR');
      expect(response.headers.get('retry-after')).toBe('1');
      expect(await balanceOf(wallet.id)).toBe('100.00');
    } finally {
      await holder.close(true);
    }
  });
});
