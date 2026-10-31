import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/mikro-orm.config.js';

let prepared: Promise<void> | undefined;
let assertionOrm: Promise<MikroORM> | undefined;

async function recreate(dbName: string): Promise<void> {
  const admin = await MikroORM.init({
    ...mikroOrmConfig,
    dbName: 'postgres',
    debug: false,
  });
  try {
    const exists = await admin.em.execute<{ found: number }[]>(
      'select 1 as found from pg_database where datname = ?',
      [dbName],
    );
    if (exists.length === 0) {
      await admin.em.execute(`create database "${dbName}"`);
    }
  } finally {
    await admin.close(true);
  }

  const orm = await MikroORM.init({
    ...mikroOrmConfig,
    dbName,
    debug: false,
    migrations: { ...mikroOrmConfig.migrations, silent: true },
  });
  try {
    await orm.em.execute('drop schema if exists public cascade');
    await orm.em.execute('create schema public');
    await orm.migrator.up();
  } finally {
    await orm.close(true);
  }
}

export function prepareDatabase(): Promise<void> {
  prepared ??= recreate(mikroOrmConfig.dbName ?? 'wallet_test');
  return prepared;
}

export async function migrationsOrm(dbName: string): Promise<MikroORM> {
  await recreate(dbName);
  return MikroORM.init({
    ...mikroOrmConfig,
    dbName,
    debug: false,
    migrations: { ...mikroOrmConfig.migrations, silent: true },
  });
}

export async function db(): Promise<MikroORM> {
  await prepareDatabase();
  assertionOrm ??= MikroORM.init({
    ...mikroOrmConfig,
    debug: false,
    pool: { max: 5 },
  });
  return assertionOrm;
}

export async function sql<T = Record<string, unknown>>(
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  const orm = await db();
  return orm.em.fork().execute<T[]>(query, params);
}

export async function balanceOf(walletId: string): Promise<string> {
  const [row] = await sql<{ balance: string }>(
    'select balance::text as balance from wallets where id = ?',
    [walletId],
  );
  if (!row) {
    throw new Error(`wallet ${walletId} not found`);
  }
  return row.balance;
}

export async function ledgerCount(
  walletId: string,
  direction?: 'DEBIT' | 'CREDIT',
): Promise<number> {
  const [row] = await sql<{ count: number }>(
    `select count(*)::int as count from wallet_ledger_entries
      where wallet_id = ? and (?::text is null or direction = ?)`,
    [walletId, direction ?? null, direction ?? null],
  );
  return row?.count ?? 0;
}

export async function expectReconciled(walletId: string): Promise<void> {
  const [row] = await sql<{
    balance: string;
    from_ledger: string;
    last_after: string | null;
  }>(
    `select w.balance::text as balance,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19, 2)::text as from_ledger,
            (select balance_after::text from wallet_ledger_entries
              where wallet_id = w.id order by seq desc limit 1) as last_after
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ?
      group by w.id, w.balance`,
    [walletId],
  );
  if (!row) {
    throw new Error(`wallet ${walletId} not found`);
  }
  if (
    row.balance !== row.from_ledger ||
    (row.last_after !== null && row.last_after !== row.balance)
  ) {
    throw new Error(
      `wallet ${walletId} not reconciled: stored=${row.balance} ledger=${row.from_ledger} lastAfter=${row.last_after}`,
    );
  }
}

export async function closeDb(): Promise<void> {
  if (assertionOrm) {
    const orm = await assertionOrm;
    assertionOrm = undefined;
    await orm.close(true);
  }
}
