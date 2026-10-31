import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import { TransientError } from '../../application/errors.js';
import {
  type TransactionScope,
  type UnitOfWork,
  WAGER_METRICS,
  type WagerMetrics,
} from '../../application/ports.js';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import {
  LOCK_CONFLICT_REASONS,
  translateDatabaseError,
} from './database-errors.js';
import { createTransactionScope } from './repositories.js';

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly em: EntityManager,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WAGER_METRICS) private readonly metrics: WagerMetrics,
  ) {}

  async transactional<T>(
    work: (scope: TransactionScope) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.em.fork().transactional(async (em) => {
        await em.execute('select set_config(?, ?, true)', [
          'lock_timeout',
          `${this.config.database.lockTimeoutMs}ms`,
        ]);
        return work(createTransactionScope(em));
      });
    } catch (error) {
      const translated = translateDatabaseError(error);
      if (
        translated instanceof TransientError &&
        LOCK_CONFLICT_REASONS.has(translated.reason)
      ) {
        this.metrics.concurrencyConflict(translated.reason);
      }
      throw translated;
    }
  }
}
