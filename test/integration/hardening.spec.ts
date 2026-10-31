import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ResolvePendingReferencesUseCase } from '../../src/application/resolve-pending-references.use-case.js';
import { encodeCursor } from '../../src/application/wallet-queries.js';
import { newId } from '../../src/domain/ids.js';
import mikroOrmConfig from '../../src/mikro-orm.config.js';
import {
  createWallet,
  keyOf,
  postWager,
  request,
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

async function holdingWalletLock<T>(
  walletId: string,
  work: () => Promise<T>,
): Promise<T> {
  const holder = await MikroORM.init({
    ...mikroOrmConfig,
    debug: false,
    pool: { max: 1 },
  });
  try {
    return await holder.em.fork().transactional(async (em) => {
      await em.execute('select id from wallets where id = ? for update', [
        walletId,
      ]);
      return work();
    });
  } finally {
    await holder.close(true);
  }
}

describe('input hardening', () => {
  it.each([
    ['a NUL byte', { externalTransactionId: 'tx\u0000evil' }],
    ['an unpaired surrogate', { roundId: '\ud800' }],
    ['a line break', { gameId: 'line\nbreak' }],
    ['an unknown currency', { money: { amount: '1.00', currency: 'ZZZ' } }],
  ])(
    'rejects %s with 400 instead of reaching the database',
    async (_, override) => {
      const wallet = await createWallet(app.baseUrl, '10.00');

      const response = await postWager(
        app.baseUrl,
        { ...wagerBody(wallet, 'BET', '1.00'), ...override },
        `key-${newId()}`,
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    },
  );

  it('validates path parameters and cursors the same way', async () => {
    const wallet = await createWallet(app.baseUrl, '10.00');

    const nul = await request(
      app.baseUrl,
      'GET',
      '/providers/provider-a/wagering/transactions/tx%00x',
    );
    const huge = await request(
      app.baseUrl,
      'GET',
      `/wallets/${wallet.id}/ledger?cursor=${encodeCursor('9999999999999999999')}`,
    );

    expect(nul.status).toBe(400);
    expect(huge.status).toBe(400);
  });

  it('answers a JSON scalar body with a validation error', async () => {
    const response = await fetch(`${app.baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '5',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('VALIDATION_ERROR');
  });

  it('treats uppercase UUIDs as the same wallet and player', async () => {
    const wallet = await createWallet(app.baseUrl, '10.00');
    const body = wagerBody(
      { id: wallet.id.toUpperCase(), playerId: wallet.playerId.toUpperCase() },
      'BET',
      '1.00',
    );

    const response = await postWager(app.baseUrl, body);

    expect(response.status).toBe(201);
    expect(await balanceOf(wallet.id)).toBe('9.00');
  });
});

describe('balance storage limit', () => {
  it('rejects a credit that would overflow numeric(19,2) as a business rule', async () => {
    const wallet = await createWallet(app.baseUrl, '99999999999999999.99');
    const body = wagerBody(wallet, 'WIN', '0.01');

    const first = await postWager(app.baseUrl, body);
    const replay = await postWager(app.baseUrl, body);

    expect(first.status).toBe(422);
    expect(first.body.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await balanceOf(wallet.id)).toBe('99999999999999999.99');
  });
});

describe('idempotency keys', () => {
  it('are scoped per provider', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    const key = `shared-${newId()}`;

    const fromA = await postWager(
      app.baseUrl,
      wagerBody(wallet, 'BET', '1.00', { providerId: 'provider-a' }),
      key,
    );
    const fromB = await postWager(
      app.baseUrl,
      wagerBody(wallet, 'BET', '2.00', { providerId: 'provider-b' }),
      key,
    );
    const reusedByA = await postWager(
      app.baseUrl,
      wagerBody(wallet, 'BET', '3.00', { providerId: 'provider-a' }),
      key,
    );

    expect(fromA.status).toBe(201);
    expect(fromB.status).toBe(201);
    expect(reusedByA.status).toBe(409);
    expect(await balanceOf(wallet.id)).toBe('97.00');
  });

  it('replay identical duplicates for a wallet that does not exist, even in parallel', async () => {
    const body = wagerBody({ id: newId(), playerId: newId() }, 'BET', '1.00');

    const responses = await Promise.all(
      Array.from({ length: 30 }, () => postWager(app.baseUrl, body)),
    );

    expect(responses.every((response) => response.status === 422)).toBe(true);
    expect(
      new Set(responses.map((response) => response.body.transactionId)).size,
    ).toBe(1);
    expect(
      responses.filter((response) => !response.body.idempotentReplay),
    ).toHaveLength(1);
  });
});

describe('locking', () => {
  it('is per wallet: a locked wallet does not block another one', async () => {
    const locked = await createWallet(app.baseUrl, '100.00');
    const free = await createWallet(app.baseUrl, '100.00');

    const [blocked, unaffected] = await holdingWalletLock(locked.id, () =>
      Promise.all([
        postWager(app.baseUrl, wagerBody(locked, 'BET', '1.00')),
        postWager(app.baseUrl, wagerBody(free, 'BET', '1.00')),
      ]),
    );
    const metrics = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());

    expect(unaffected.status).toBe(201);
    expect(blocked.status).toBe(503);
    expect(metrics).toMatch(
      /concurrency_conflicts_total\{reason="55P03"\} [1-9]/,
    );
    expect(await balanceOf(locked.id)).toBe('100.00');
  });
});

describe('use case atomicity', () => {
  it('commits nothing when the last write of the transaction fails', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    await sql(`
      create or replace function test_fail_outbox() returns trigger language plpgsql as $$
      begin
        if new.aggregate_id = '${wallet.id}' then
          raise exception 'injected outbox failure';
        end if;
        return new;
      end $$`);
    await sql(
      'create trigger trg_test_fail_outbox before insert on outbox_messages for each row execute function test_fail_outbox()',
    );
    try {
      const response = await postWager(
        app.baseUrl,
        wagerBody(wallet, 'BET', '40.00'),
      );

      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain('injected');
    } finally {
      await sql('drop trigger trg_test_fail_outbox on outbox_messages');
      await sql('drop function test_fail_outbox()');
    }

    const [bets] = await sql<{ count: number }>(
      "select count(*)::int as count from wager_transactions where wallet_id = ? and kind = 'BET'",
      [wallet.id],
    );
    expect(bets?.count).toBe(0);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(0);
    await expectReconciled(wallet.id);
  });
});

describe('pending reference worker', () => {
  it('parks a transaction that fails permanently as FAILED instead of retrying it forever', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    const betId = `tx-${newId()}`;
    const refund = wagerBody(wallet, 'REFUND', '10.00', {
      referenceExternalTransactionId: betId,
    });
    const pending = await postWager(app.baseUrl, refund);
    const poisonId = pending.body.transactionId as string;
    await sql(`
      create or replace function test_poison() returns trigger language plpgsql as $$
      begin
        if new.id = '${poisonId}' and new.status <> 'FAILED' then
          raise exception 'injected poison';
        end if;
        return new;
      end $$`);
    await sql(
      'create trigger trg_test_poison before update on wager_transactions for each row execute function test_poison()',
    );
    const resolver = app.app.get(ResolvePendingReferencesUseCase);
    try {
      await postWager(
        app.baseUrl,
        wagerBody(wallet, 'BET', '10.00', { externalTransactionId: betId }),
      );
      await waitFor(
        async () => {
          await resolver.runOnce(50);
          const [row] = await sql<{ status: string }>(
            'select status from wager_transactions where id = ?',
            [poisonId],
          );
          return row?.status;
        },
        (status) => status === 'FAILED',
      );
    } finally {
      await sql('drop trigger trg_test_poison on wager_transactions');
      await sql('drop function test_poison()');
    }

    const replay = await postWager(app.baseUrl, refund, keyOf(refund));
    expect(replay.body).toMatchObject({
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
    });
    expect(replay.status).toBe(422);
    expect(await balanceOf(wallet.id)).toBe('90.00');
    await expectReconciled(wallet.id);
  });
});
