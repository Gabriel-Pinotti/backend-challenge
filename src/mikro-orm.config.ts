import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletRecord } from './wallet/infrastructure/wallet.record.js';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'wallet',
  password: process.env.POSTGRES_PASSWORD ?? 'wallet',
  dbName: process.env.POSTGRES_DB ?? 'wallet',
  entities: [WalletRecord],
  extensions: [Migrator],
  migrations: {
    path: 'src/database/migrations',
    pathTs: 'src/database/migrations',
    snapshot: false,
    snapshotOnMigrate: false,
  },
});
