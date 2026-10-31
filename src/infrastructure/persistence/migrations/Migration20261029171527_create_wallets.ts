import { Migration } from '@mikro-orm/migrations';

export class Migration20261029171527_create_wallets extends Migration {
  override name = 'Migration20261029171527_create_wallets';

  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(19, 2) not null,
        version integer not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint uq_wallets_player_currency unique (player_id, currency),
        constraint ck_wallets_balance_non_negative check (balance >= 0),
        constraint ck_wallets_version_positive check (version >= 1)
      );
    `);
  }

  override down(): void {
    this.addSql(`drop table wallets;`);
  }
}
