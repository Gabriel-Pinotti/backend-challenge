import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EVENT_PUBLISHER,
  type EventPublisher,
  UNIT_OF_WORK,
  type UnitOfWork,
  WAGER_METRICS,
  type WagerMetrics,
} from './ports.js';

@Injectable()
export class PublishOutboxUseCase {
  private readonly logger = new Logger(PublishOutboxUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(WAGER_METRICS) private readonly metrics: WagerMetrics,
  ) {}

  async publishBatch(limit: number): Promise<number> {
    return this.uow.transactional(async (scope) => {
      const batch = await scope.outbox.lockDueBatch(new Date(), limit);
      if (batch.length === 0) {
        return 0;
      }
      const failed = await this.publisher
        .publish(batch)
        .catch((error: unknown) => {
          this.logger.warn({ msg: 'outbox batch publish failed', error });
          return new Set(batch.map((message) => message.id));
        });
      const now = new Date();
      for (const message of batch) {
        if (failed.has(message.id)) {
          message.scheduleRetry(now);
          this.metrics.outboxPublishFailure();
          this.logger.warn({
            msg: 'outbox publish failed',
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
          });
        } else {
          message.markPublished(now);
        }
      }
      await scope.outbox.saveAll(batch);
      this.metrics.outboxPublished(batch.length - failed.size);
      return batch.length;
    });
  }

  oldestPendingAgeSeconds(): Promise<number> {
    return this.uow.transactional((scope) =>
      scope.outbox.oldestPendingAgeSeconds(),
    );
  }
}
