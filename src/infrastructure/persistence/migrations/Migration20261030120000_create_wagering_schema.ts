import { Migration } from '@mikro-orm/migrations';

export class Migration20261030120000_create_wagering_schema extends Migration {
  override name = 'Migration20261030120000_create_wagering_schema';

  override up(): void {
    this.addSql(`
      alter table wallets
        add constraint uq_wallets_id_currency unique (id, currency);
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash char(64) not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(19, 2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null,
        failure_code text,
        balance_after numeric(19, 2),
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null default now(),
        processed_at timestamptz,
        constraint uq_wager_transactions_idempotency_key unique (provider_id, idempotency_key),
        constraint uq_wager_transactions_provider_external unique (provider_id, external_transaction_id),
        constraint uq_wager_transactions_id_wallet unique (id, wallet_id),
        constraint ck_wager_transactions_kind
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint ck_wager_transactions_status
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint ck_wager_transactions_amount_non_negative check (amount >= 0),
        constraint ck_wager_transactions_balance_after_non_negative check (balance_after >= 0),
        constraint ck_wager_transactions_reference_required
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint ck_wager_transactions_reference_allowed
          check (kind in ('WIN', 'LOSS', 'REFUND', 'ROLLBACK') or reference_external_transaction_id is null),
        constraint ck_wager_transactions_failure_code
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint ck_wager_transactions_processed_has_balance
          check (status <> 'PROCESSED' or balance_after is not null),
        constraint ck_wager_transactions_terminal_has_processed_at
          check ((status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)),
        constraint ck_wager_transactions_pending_has_schedule
          check ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null)),
        constraint ck_wager_transactions_reference_attempts check (reference_attempts >= 0)
      );
    `);

    this.addSql(`
      create unique index uq_wager_transactions_single_reversal
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      create index ix_wager_transactions_pending_reference
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create index ix_wager_transactions_wallet on wager_transactions (wallet_id);
    `);

    this.addSql(`
      create function guard_wager_transaction() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions rows cannot be deleted';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is terminal (%)', old.id, old.status;
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
            new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id,
            new.kind, new.amount, new.currency, new.reference_external_transaction_id,
            new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
            old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id,
            old.kind, old.amount, old.currency, old.reference_external_transaction_id,
            old.created_at) then
          raise exception 'wager transaction % has immutable fields', old.id;
        end if;
        return new;
      end $$;
    `);

    this.addSql(`
      create trigger trg_wager_transactions_guard
        before update or delete on wager_transactions
        for each row execute function guard_wager_transaction();
    `);

    this.addSql(`
      create function require_existing_wallet() returns trigger
      language plpgsql as $$
      begin
        if not exists (select 1 from wallets where id = new.wallet_id)
           and not (new.status = 'REJECTED' and new.failure_code = 'WALLET_NOT_FOUND') then
          raise exception 'wallet % does not exist', new.wallet_id;
        end if;
        return new;
      end $$;
    `);

    this.addSql(`
      create trigger trg_wager_transactions_wallet_exists
        before insert on wager_transactions
        for each row execute function require_existing_wallet();
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        seq bigint generated always as identity,
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(19, 2) not null,
        currency char(3) not null,
        balance_before numeric(19, 2) not null,
        balance_after numeric(19, 2) not null,
        created_at timestamptz not null default now(),
        constraint uq_wallet_ledger_entries_seq unique (seq),
        constraint uq_wallet_ledger_entries_transaction_wallet unique (transaction_id, wallet_id),
        constraint fk_wallet_ledger_entries_wallet_currency
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint fk_wallet_ledger_entries_transaction_wallet
          foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        constraint ck_wallet_ledger_entries_direction check (direction in ('DEBIT', 'CREDIT')),
        constraint ck_wallet_ledger_entries_amount_positive check (amount > 0),
        constraint ck_wallet_ledger_entries_balances_non_negative
          check (balance_before >= 0 and balance_after >= 0),
        constraint ck_wallet_ledger_entries_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql(`
      create index ix_wallet_ledger_entries_wallet_seq
        on wallet_ledger_entries (wallet_id, seq);
    `);

    this.addSql(`
      create function forbid_ledger_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only';
      end $$;
    `);

    this.addSql(`
      create trigger trg_wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function forbid_ledger_mutation();
    `);

    this.addSql(`
      create trigger trg_wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function forbid_ledger_mutation();
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null,
        received_at timestamptz not null default now(),
        processed_at timestamptz,
        constraint pk_inbox_messages primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null default now(),
        published_at timestamptz,
        constraint ck_outbox_messages_attempts check (attempts >= 0)
      );
    `);

    this.addSql(`
      create index ix_outbox_messages_pending
        on outbox_messages (next_attempt_at, occurred_at)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql(`drop table outbox_messages;`);
    this.addSql(`drop table inbox_messages;`);
    this.addSql(`drop table wallet_ledger_entries;`);
    this.addSql(`drop function forbid_ledger_mutation();`);
    this.addSql(`drop table wager_transactions;`);
    this.addSql(`drop function guard_wager_transaction();`);
    this.addSql(`drop function require_existing_wallet();`);
    this.addSql(`alter table wallets drop constraint uq_wallets_id_currency;`);
  }
}
