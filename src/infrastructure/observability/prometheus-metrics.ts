import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { WagerMetrics } from '../../application/ports.js';

@Injectable()
export class PrometheusMetrics implements WagerMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions settled, by final status and kind',
    labelNames: ['status', 'kind'] as const,
    registers: [this.registry],
  });

  private readonly replays = new Counter({
    name: 'idempotent_replays_total',
    help: 'Requests answered from a previously stored result',
    registers: [this.registry],
  });

  private readonly inboxDuplicates = new Counter({
    name: 'inbox_duplicates_total',
    help: 'SQS messages already present in the inbox',
    registers: [this.registry],
  });

  private readonly conflicts = new Counter({
    name: 'concurrency_conflicts_total',
    help: 'Lock timeouts, deadlocks and unique-constraint races',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly duration = new Histogram({
    name: 'wager_processing_seconds',
    help: 'Wager use case duration',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly reconciliationMismatches = new Counter({
    name: 'reconciliation_mismatches_total',
    help: 'Wallets whose stored balance diverged from the ledger',
    registers: [this.registry],
  });

  private readonly pendingReferenceAttempts = new Counter({
    name: 'pending_reference_attempts_total',
    help: 'Pending reference resolution attempts, by resulting status',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  private readonly outboxPublishedTotal = new Counter({
    name: 'outbox_published_total',
    help: 'Outbox messages published',
    registers: [this.registry],
  });

  private readonly outboxFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Outbox publish attempts that failed and were rescheduled',
    registers: [this.registry],
  });

  readonly sqsRetries = new Counter({
    name: 'sqs_retries_total',
    help: 'SQS messages returned to the queue after a transient failure',
    registers: [this.registry],
  });

  readonly sqsDeadLettered = new Counter({
    name: 'sqs_dlq_total',
    help: 'SQS messages moved to the DLQ by the consumer',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly sqsDlqDepth = new Gauge({
    name: 'sqs_dlq_messages',
    help: 'Approximate number of messages waiting in the DLQ',
    registers: [this.registry],
  });

  readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });

  transactionSettled(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }

  idempotentReplay(): void {
    this.replays.inc();
  }

  inboxDuplicate(): void {
    this.inboxDuplicates.inc();
  }

  concurrencyConflict(reason: string): void {
    this.conflicts.inc({ reason });
  }

  processingDuration(seconds: number): void {
    this.duration.observe(seconds);
  }

  reconciliationMismatch(): void {
    this.reconciliationMismatches.inc();
  }

  pendingReferenceAttempt(outcome: string): void {
    this.pendingReferenceAttempts.inc({ outcome });
  }

  outboxPublished(count: number): void {
    if (count > 0) {
      this.outboxPublishedTotal.inc(count);
    }
  }

  outboxPublishFailure(): void {
    this.outboxFailures.inc();
  }
}
