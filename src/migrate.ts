import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from './mikro-orm.config.js';

const orm = await MikroORM.init(mikroOrmConfig);
try {
  const applied = await orm.migrator.up();
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'migrations applied',
      count: applied.length,
    }),
  );
} finally {
  await orm.close(true);
}
