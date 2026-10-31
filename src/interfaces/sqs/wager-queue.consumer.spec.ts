import { describe, expect, it } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { TransientError } from '../../application/errors.js';
import type { UnitOfWork } from '../../application/ports.js';
import type { SubmitWagerUseCase } from '../../application/submit-wager.use-case.js';
import { loadConfig } from '../../config.js';
import type { SqsGateway } from '../../infrastructure/messaging/sqs-gateway.js';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics.js';
import { WagerQueueConsumer } from './wager-queue.consumer.js';

function message(id: number): Message {
  return {
    MessageId: `sqs-${id}`,
    ReceiptHandle: `receipt-${id}`,
    Attributes: { ApproximateReceiveCount: '1' },
    Body: JSON.stringify({
      messageId: `msg-${id}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: `tx-${id}`,
        idempotencyKey: `provider-a:tx-${id}`,
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
    }),
  };
}

async function eventually(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

Logger.overrideLogger(false);

describe('WagerQueueConsumer', () => {
  it('stops receiving while the database is down instead of burning retries', async () => {
    let databaseUp = false;
    let receives = 0;
    const processed: string[] = [];
    const visibility: { receipt: string; seconds: number }[] = [];
    const batches: Message[][] = [[message(1), message(2), message(3)]];

    const sqs = {
      async receiveWagers() {
        receives += 1;
        const batch = batches.shift();
        if (batch) {
          return batch;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [];
      },
      async changeWagerVisibility(receipt: string, seconds: number) {
        visibility.push({ receipt, seconds });
      },
      async deleteWager() {},
      async sendToWagerDlq() {},
    } as unknown as SqsGateway;
    const submitWager = {
      async execute(command: { idempotencyKey: string }) {
        if (!databaseUp) {
          throw new TransientError(
            'database temporarily unavailable',
            'connection',
          );
        }
        processed.push(command.idempotencyKey);
        return {
          transactionId: 't',
          status: 'PROCESSED',
          balance: null,
          idempotentReplay: false,
        };
      },
    } as unknown as SubmitWagerUseCase;
    const uow = {
      async transactional() {
        if (!databaseUp) {
          throw new TransientError(
            'database temporarily unavailable',
            'connection',
          );
        }
      },
    } as unknown as UnitOfWork;
    const config = loadConfig({
      NODE_ENV: 'test',
      SQS_UNAVAILABLE_BACKOFF_MS: '5',
      SQS_MAX_BACKOFF_SECONDS: '60',
    });
    const consumer = new WagerQueueConsumer(
      submitWager,
      sqs,
      new PrometheusMetrics(),
      uow,
      config,
    );

    consumer.start();
    await eventually(() => visibility.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receives).toBe(1);
    expect(visibility).toEqual([
      { receipt: 'receipt-1', seconds: 2 },
      { receipt: 'receipt-2', seconds: 5 },
      { receipt: 'receipt-3', seconds: 5 },
    ]);
    expect(processed).toEqual([]);

    databaseUp = true;
    batches.push([message(2)]);
    await eventually(() => processed.length === 1);
    await consumer.stop();

    expect(processed).toEqual(['provider-a:tx-2']);
    expect(receives).toBeGreaterThan(1);
  });

  it('on shutdown finishes the message in flight and hands the rest back at once', async () => {
    const deleted: string[] = [];
    const visibility: { receipt: string; seconds: number }[] = [];
    const processed: string[] = [];
    let firstBatch = true;
    let finishFirst: () => void = () => {};
    let firstStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const sqs = {
      async receiveWagers(_wait: number, signal: AbortSignal) {
        if (firstBatch) {
          firstBatch = false;
          return [message(1), message(2), message(3)];
        }
        return new Promise<Message[]>((resolve) =>
          signal.addEventListener('abort', () => resolve([])),
        );
      },
      async changeWagerVisibility(receipt: string, seconds: number) {
        visibility.push({ receipt, seconds });
      },
      async deleteWager(receipt: string) {
        deleted.push(receipt);
      },
      async sendToWagerDlq() {},
    } as unknown as SqsGateway;
    const submitWager = {
      async execute(command: { idempotencyKey: string }) {
        if (command.idempotencyKey === 'provider-a:tx-1') {
          firstStarted();
          await new Promise<void>((resolve) => {
            finishFirst = resolve;
          });
        }
        processed.push(command.idempotencyKey);
        return {
          transactionId: 't',
          status: 'PROCESSED',
          balance: null,
          idempotentReplay: false,
        };
      },
    } as unknown as SubmitWagerUseCase;
    const uow = { async transactional() {} } as unknown as UnitOfWork;
    const consumer = new WagerQueueConsumer(
      submitWager,
      sqs,
      new PrometheusMetrics(),
      uow,
      loadConfig({ NODE_ENV: 'test' }),
    );

    consumer.start();
    await started;
    const stopping = consumer.stop();
    finishFirst();
    await stopping;

    expect(processed).toEqual(['provider-a:tx-1']);
    expect(deleted).toEqual(['receipt-1']);
    expect(visibility).toEqual([
      { receipt: 'receipt-2', seconds: 0 },
      { receipt: 'receipt-3', seconds: 0 },
    ]);
  });

  it('keeps FIFO order inside a group after a transient failure', async () => {
    const processed: string[] = [];
    const visibility: { receipt: string; seconds: number }[] = [];
    let firstBatch = true;
    const inGroup = (id: number, group: string): Message => ({
      ...message(id),
      Attributes: { ApproximateReceiveCount: '1', MessageGroupId: group },
    });
    const sqs = {
      async receiveWagers() {
        if (firstBatch) {
          firstBatch = false;
          return [
            inGroup(1, 'wallet-a'),
            inGroup(2, 'wallet-a'),
            inGroup(3, 'wallet-b'),
          ];
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [];
      },
      async changeWagerVisibility(receipt: string, seconds: number) {
        visibility.push({ receipt, seconds });
      },
      async deleteWager() {},
      async sendToWagerDlq() {},
    } as unknown as SqsGateway;
    const submitWager = {
      async execute(command: { idempotencyKey: string }) {
        if (command.idempotencyKey === 'provider-a:tx-1') {
          throw new TransientError('lock timeout', '55P03');
        }
        processed.push(command.idempotencyKey);
        return {
          transactionId: 't',
          status: 'PROCESSED',
          balance: null,
          idempotentReplay: false,
        };
      },
    } as unknown as SubmitWagerUseCase;
    const uow = { async transactional() {} } as unknown as UnitOfWork;
    const consumer = new WagerQueueConsumer(
      submitWager,
      sqs,
      new PrometheusMetrics(),
      uow,
      loadConfig({ NODE_ENV: 'test', SQS_MAX_BACKOFF_SECONDS: '60' }),
    );

    consumer.start();
    await eventually(() => processed.length === 1);
    await consumer.stop();

    expect(processed).toEqual(['provider-a:tx-3']);
    expect(visibility).toEqual([
      { receipt: 'receipt-1', seconds: 2 },
      { receipt: 'receipt-2', seconds: 0 },
    ]);
  });
});
