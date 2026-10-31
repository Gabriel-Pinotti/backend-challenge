import { afterAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/ids.js';
import mikroOrmConfig from '../../src/mikro-orm.config.js';
import { rejectionOf } from '../support/assertions.js';
import { closeDb, migrationsOrm, sql } from '../support/database.js';

afterAll(async () => {
  await closeDb();
});

async function expectRejected(
  query: string,
  params: unknown[],
  reason: RegExp,
): Promise<void> {
  expect((await rejectionOf(sql(query, params))).message).toMatch(reason);
}

async function wallet(balance = '100.00', currency = 'BRL') {
  const id = newId();
  const playerId = newId();
  await sql(
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, 1, now(), now())`,
    [id, playerId, currency, balance],
  );
  return { id, playerId };
}

async function transaction(
  walletId: string,
  playerId: string,
  overrides: Record<string, unknown> = {},
) {
  const row = {
    id: newId(),
    provider_id: 'provider-a',
    external_transaction_id: `ext-${newId()}`,
    idempotency_key: `key-${newId()}`,
    payload_hash: 'a'.repeat(64),
    wallet_id: walletId,
    player_id: playerId,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status: 'PROCESSED',
    failure_code: null,
    balance_after: '90.00',
    processed_at: new Date(),
    next_reference_attempt_at: null,
    ...overrides,
  };
  const columns = Object.keys(row);
  await sql(
    `insert into wager_transactions (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  );
  return row;
}

describe('migrations', () => {
  it('are reversible', async () => {
    const orm = await migrationsOrm(`${mikroOrmConfig.dbName}_migrations`);
    const tables = async () =>
      (
        await orm.em.execute<{ table_name: string }[]>(
          "select table_name from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1",
        )
      ).map((row) => row.table_name);
    try {
      expect(await tables()).toEqual([
        'inbox_messages',
        'outbox_messages',
        'wager_transactions',
        'wallet_ledger_entries',
        'wallets',
      ]);

      await orm.migrator.down({ to: 0 });
      expect(await tables()).toEqual([]);

      await orm.migrator.up();
      expect(await tables()).toHaveLength(5);
    } finally {
      await orm.close(true);
    }
  });
});

describe('schema constraints', () => {
  it('keeps balances non-negative', async () => {
    await expectRejected(
      'insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, -0.01, 1, now(), now())',
      [newId(), newId(), 'BRL'],
      /ck_wallets_balance_non_negative/,
    );
  });

  it('allows one wallet per player and currency', async () => {
    const { playerId } = await wallet();

    await expectRejected(
      'insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, 0, 1, now(), now())',
      [newId(), playerId, 'BRL'],
      /uq_wallets_player_currency/,
    );
  });

  describe('wallet_ledger_entries', () => {
    const insertEntry = (
      walletId: string,
      transactionId: string,
      values: {
        direction?: string;
        amount?: string;
        before?: string;
        after?: string;
        currency?: string;
      } = {},
    ) =>
      sql(
        `insert into wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          walletId,
          transactionId,
          values.direction ?? 'DEBIT',
          values.amount ?? '10.00',
          values.currency ?? 'BRL',
          values.before ?? '100.00',
          values.after ?? '90.00',
        ],
      );

    it('validates the arithmetic of every entry', async () => {
      const w = await wallet();
      const tx = await transaction(w.id, w.playerId);

      expect(
        (await rejectionOf(insertEntry(w.id, tx.id, { after: '91.00' })))
          .message,
      ).toMatch(/ck_wallet_ledger_entries_arithmetic/);
    });

    it('stores at most one entry per transaction and wallet', async () => {
      const w = await wallet();
      const tx = await transaction(w.id, w.playerId);
      await insertEntry(w.id, tx.id);

      expect((await rejectionOf(insertEntry(w.id, tx.id))).message).toMatch(
        /uq_wallet_ledger_entries_transaction_wallet/,
      );
    });

    it('requires the wallet currency and a transaction of the same wallet', async () => {
      const w = await wallet();
      const other = await wallet();
      const tx = await transaction(w.id, w.playerId);

      expect(
        (await rejectionOf(insertEntry(w.id, tx.id, { currency: 'USD' })))
          .message,
      ).toMatch(/fk_wallet_ledger_entries_wallet_currency/);
      expect((await rejectionOf(insertEntry(other.id, tx.id))).message).toMatch(
        /fk_wallet_ledger_entries_transaction_wallet/,
      );
    });

    it('is append-only', async () => {
      const w = await wallet();
      const tx = await transaction(w.id, w.playerId);
      await insertEntry(w.id, tx.id);

      await expectRejected(
        'update wallet_ledger_entries set amount = 1 where wallet_id = ?',
        [w.id],
        /append-only/,
      );
      await expectRejected(
        'delete from wallet_ledger_entries where wallet_id = ?',
        [w.id],
        /append-only/,
      );
      await expectRejected(
        'truncate wallet_ledger_entries cascade',
        [],
        /append-only/,
      );
    });
  });

  describe('wager_transactions', () => {
    it('enforces idempotency and provider uniqueness', async () => {
      const w = await wallet();
      const tx = await transaction(w.id, w.playerId);
      await transaction(w.id, w.playerId, {
        provider_id: 'provider-b',
        idempotency_key: tx.idempotency_key,
      });

      expect(
        (
          await rejectionOf(
            transaction(w.id, w.playerId, {
              idempotency_key: tx.idempotency_key,
            }),
          )
        ).message,
      ).toMatch(/uq_wager_transactions_idempotency_key/);
      expect(
        (
          await rejectionOf(
            transaction(w.id, w.playerId, {
              external_transaction_id: tx.external_transaction_id,
            }),
          )
        ).message,
      ).toMatch(/uq_wager_transactions_provider_external/);
    });

    it('allows a reference to be reversed only once', async () => {
      const w = await wallet();
      const bet = await transaction(w.id, w.playerId);
      const reversal = (kind: string) => ({
        kind,
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
      });
      await transaction(w.id, w.playerId, reversal('REFUND'));

      expect(
        (await rejectionOf(transaction(w.id, w.playerId, reversal('ROLLBACK'))))
          .message,
      ).toMatch(/uq_wager_transactions_single_reversal/);
    });

    it('only lets a WALLET_NOT_FOUND rejection point to a missing wallet', async () => {
      const missingWallet = newId();

      expect(
        (await rejectionOf(transaction(missingWallet, newId()))).message,
      ).toMatch(/does not exist/);
      await transaction(missingWallet, newId(), {
        status: 'REJECTED',
        failure_code: 'WALLET_NOT_FOUND',
        balance_after: null,
      });
    });

    it('requires references and failure codes where the rules demand them', async () => {
      const w = await wallet();

      expect(
        (await rejectionOf(transaction(w.id, w.playerId, { kind: 'REFUND' })))
          .message,
      ).toMatch(/ck_wager_transactions_reference_required/);
      expect(
        (
          await rejectionOf(
            transaction(w.id, w.playerId, { status: 'REJECTED' }),
          )
        ).message,
      ).toMatch(/ck_wager_transactions_failure_code/);
      expect(
        (await rejectionOf(transaction(w.id, w.playerId, { amount: '-1.00' })))
          .message,
      ).toMatch(/ck_wager_transactions_amount_non_negative/);
    });

    it('freezes terminal transactions and immutable fields', async () => {
      const w = await wallet();
      const processed = await transaction(w.id, w.playerId);
      const pending = await transaction(w.id, w.playerId, {
        kind: 'REFUND',
        reference_external_transaction_id: 'later',
        status: 'PENDING_REFERENCE',
        balance_after: '100.00',
        processed_at: null,
        next_reference_attempt_at: new Date(),
      });

      await expectRejected(
        "update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ?",
        [processed.id],
        /is terminal/,
      );
      await expectRejected(
        'update wager_transactions set amount = 1 where id = ?',
        [pending.id],
        /immutable fields/,
      );
      await expectRejected(
        'delete from wager_transactions where id = ?',
        [pending.id],
        /cannot be deleted/,
      );
    });
  });

  it('deduplicates inbox messages per consumer', async () => {
    const messageId = newId();
    const insert = (consumer: string) =>
      sql(
        'insert into inbox_messages (consumer_name, message_id, payload_hash) values (?, ?, ?)',
        [consumer, messageId, 'a'.repeat(64)],
      );
    await insert('consumer-a');
    await insert('consumer-b');

    expect((await rejectionOf(insert('consumer-a'))).message).toMatch(
      /pk_inbox_messages/,
    );
  });
});
