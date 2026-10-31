import { MikroOrmModule } from '@mikro-orm/nestjs';
import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CreateWalletUseCase } from './application/create-wallet.use-case.js';
import {
  EVENT_PUBLISHER,
  REFERENCE_RETRY_POLICY,
  UNIT_OF_WORK,
  WAGER_METRICS,
} from './application/ports.js';
import { PublishOutboxUseCase } from './application/publish-outbox.use-case.js';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case.js';
import { ResolvePendingReferencesUseCase } from './application/resolve-pending-references.use-case.js';
import { SubmitWagerUseCase } from './application/submit-wager.use-case.js';
import { WalletQueries } from './application/wallet-queries.js';
import { APP_CONFIG, type AppConfig, loadConfig } from './config.js';
import { ReferenceRetryPolicy } from './domain/reference-retry-policy.js';
import { SqsGateway } from './infrastructure/messaging/sqs-gateway.js';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics.js';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work.js';
import { PollingWorker } from './infrastructure/workers/polling-worker.js';
import { CorrelationMiddleware } from './interfaces/http/correlation.middleware.js';
import { HealthController } from './interfaces/http/health.controller.js';
import { HttpErrorFilter } from './interfaces/http/http-error.filter.js';
import { MetricsController } from './interfaces/http/metrics.controller.js';
import {
  AllowAllProviderIdentity,
  PROVIDER_IDENTITY,
  ProviderAuthGuard,
} from './interfaces/http/provider-identity.js';
import { WageringController } from './interfaces/http/wagering.controller.js';
import { WalletsController } from './interfaces/http/wallets.controller.js';
import { WagerQueueConsumer } from './interfaces/sqs/wager-queue.consumer.js';
import mikroOrmConfig from './mikro-orm.config.js';

export const OUTBOX_WORKER = Symbol('OUTBOX_WORKER');
export const PENDING_REFERENCE_WORKER = Symbol('PENDING_REFERENCE_WORKER');

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  controllers: [
    WalletsController,
    WageringController,
    HealthController,
    MetricsController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    PrometheusMetrics,
    { provide: WAGER_METRICS, useExisting: PrometheusMetrics },
    { provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork },
    SqsGateway,
    { provide: EVENT_PUBLISHER, useExisting: SqsGateway },
    {
      provide: REFERENCE_RETRY_POLICY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new ReferenceRetryPolicy(config.pendingReferences),
    },
    SubmitWagerUseCase,
    CreateWalletUseCase,
    ReconcileWalletUseCase,
    ResolvePendingReferencesUseCase,
    PublishOutboxUseCase,
    WalletQueries,
    WagerQueueConsumer,
    {
      provide: OUTBOX_WORKER,
      inject: [PublishOutboxUseCase, APP_CONFIG],
      useFactory: (publishOutbox: PublishOutboxUseCase, config: AppConfig) =>
        new PollingWorker({
          name: 'OutboxPublisher',
          enabled: config.outbox.enabled,
          intervalMs: config.outbox.pollIntervalMs,
          batchSize: config.outbox.batchSize,
          shutdownTimeoutMs: config.consumer.shutdownTimeoutMs,
          tick: (batchSize) => publishOutbox.publishBatch(batchSize),
        }),
    },
    {
      provide: PENDING_REFERENCE_WORKER,
      inject: [ResolvePendingReferencesUseCase, APP_CONFIG],
      useFactory: (
        resolvePending: ResolvePendingReferencesUseCase,
        config: AppConfig,
      ) =>
        new PollingWorker({
          name: 'PendingReferenceResolver',
          enabled: config.pendingReferences.enabled,
          intervalMs: config.pendingReferences.pollIntervalMs,
          batchSize: config.pendingReferences.batchSize,
          shutdownTimeoutMs: config.consumer.shutdownTimeoutMs,
          tick: (batchSize) => resolvePending.runOnce(batchSize),
        }),
    },
    { provide: PROVIDER_IDENTITY, useClass: AllowAllProviderIdentity },
    ProviderAuthGuard,
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
