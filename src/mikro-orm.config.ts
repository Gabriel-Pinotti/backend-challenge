import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { loadConfig } from './config.js';
import { ALL_RECORDS } from './infrastructure/persistence/records/index.js';

const { database } = loadConfig();

export default defineConfig({
  host: database.host,
  port: database.port,
  user: database.user,
  password: database.password,
  dbName: database.name,
  entities: ALL_RECORDS,
  extensions: [Migrator],
  pool: { max: database.poolMax },
  migrations: {
    path: 'src/infrastructure/persistence/migrations',
    pathTs: 'src/infrastructure/persistence/migrations',
    snapshot: false,
    snapshotOnMigrate: false,
  },
});
