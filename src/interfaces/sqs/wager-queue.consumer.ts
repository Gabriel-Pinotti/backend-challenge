import type { Message } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  DataIntegrityError,
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InboxConflictError,
} from '../../application/errors.js';
import { canonicalJson, sha256Hex } from '../../application/payload-hash.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../../application/ports.js';
import { SubmitWagerUseCase } from '../../application/submit-wager.use-case.js';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { DomainError } from '../../domain/errors.js';
import { SqsGateway } from '../../infrastructure/messaging/sqs-gateway.js';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics.js';
import { RequestContext } from '../../infrastructure/observability/request-context.js';
import {
  parseOrThrow,
  RequestValidationError,
  type WagerMessage,
  wagerMessageSchema,
} from '../schemas.js';

export const WAGER_CONSUMER_NAME = 'wallet-service.wager-transactions';

export type HandleOutcome = 'acked' | 'dead-lettered' | 'retry-scheduled';

function isPermanent(error: unknown): error is Error & { code: string } {
  return (
    error instanceof RequestValidationError ||
    error instanceof IdempotencyConflictError ||
    error instanceof DuplicateExternalTransactionError ||
    error instanceof InboxConflictError ||
    error instanceof DataIntegrityError ||
    error instanceof DomainError
  );
}

@Injectable()
export class WagerQueueConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(WagerQueueConsumer.name);
  private running = false;
  private loop: Promise<void> | undefined;
  private abort = new AbortController();
  private databaseSuspect = false;

  constructor(
    private readonly submitWager: SubmitWagerUseCase,
    private readonly sqs: SqsGateway,
    private readonly metrics: PrometheusMetrics,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.consumer.enabled) {
      this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    if (!this.loop) {
      return;
    }
    this.running = false;
    this.abort.abort();
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, this.config.consumer.shutdownTimeoutMs),
    );
    await Promise.race([this.loop, timeout]);
    this.loop = undefined;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      if (this.databaseSuspect && !(await this.waitForDatabase())) {
        break;
      }
      let messages: Message[];
      try {
        messages = await this.sqs.receiveWagers(
          this.config.consumer.waitTimeSeconds,
          this.abort.signal,
        );
      } catch (error) {
        if (!this.running) {
          break;
        }
        this.logger.warn({ msg: 'receive failed', error });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      const blockedGroups = new Set<string>();
      for (const [index, message] of messages.entries()) {
        const group = message.Attributes?.MessageGroupId;
        if (!this.running) {
          await this.release(messages.slice(index), 0);
          break;
        }
        if (this.databaseSuspect && !(await this.databaseAvailable())) {
          await this.release(
            messages.slice(index),
            Math.min(5, this.config.consumer.maxBackoffSeconds),
          );
          break;
        }
        if (group && blockedGroups.has(group)) {
          await this.release([message], 0);
          continue;
        }
        const outcome = await this.handle(message).catch((error: unknown) => {
          this.logger.error({
            msg: 'message left in queue after unexpected failure',
            error,
          });
          return 'retry-scheduled' as const;
        });
        if (outcome === 'retry-scheduled' && group) {
          blockedGroups.add(group);
        }
      }
    }
  }

  async handle(message: Message): Promise<HandleOutcome> {
    let envelope: WagerMessage;
    try {
      envelope = parseOrThrow(
        wagerMessageSchema,
        JSON.parse(message.Body ?? ''),
      );
    } catch (error) {
      return this.deadLetter(message, 'INVALID_MESSAGE', error);
    }
    const { data } = envelope;
    const correlationId = envelope.correlationId ?? envelope.messageId;
    return RequestContext.run(
      {
        correlationId,
        messageId: envelope.messageId,
        walletId: data.walletId,
        providerId: data.providerId,
      },
      () => this.process(message, envelope, correlationId),
    );
  }

  private async process(
    message: Message,
    envelope: WagerMessage,
    correlationId: string,
  ): Promise<HandleOutcome> {
    const { idempotencyKey, ...payload } = envelope.data;
    try {
      const result = await this.submitWager.execute({
        idempotencyKey,
        payload,
        context: { correlationId, causationId: envelope.messageId },
        inbox: {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: envelope.messageId,
          payloadHash: sha256Hex(canonicalJson(envelope.data)),
        },
      });
      this.logger.log({
        msg: 'wager message handled',
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      });
    } catch (error) {
      if (isPermanent(error)) {
        return this.deadLetter(message, error.code, error);
      }
      return this.retryLater(message, error);
    }

    if (this.config.faultInjection.exitAfterCommitBeforeAck) {
      this.logger.warn({
        msg: 'fault injection: exiting after commit, before ack',
      });
      process.exit(86);
    }

    await this.ack(message);
    return 'acked';
  }

  private async ack(message: Message): Promise<void> {
    try {
      await this.sqs.deleteWager(message.ReceiptHandle ?? '');
    } catch (error) {
      this.logger.warn({
        msg: 'ack failed; message will be redelivered and replayed',
        error,
      });
    }
  }

  private async retryLater(
    message: Message,
    error: unknown,
  ): Promise<HandleOutcome> {
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? '1',
    );
    const delaySeconds = Math.min(
      2 ** receiveCount,
      this.config.consumer.maxBackoffSeconds,
    );
    this.metrics.sqsRetries.inc();
    this.databaseSuspect = true;
    this.logger.warn({
      msg: 'transient failure, message will be retried',
      receiveCount,
      delaySeconds,
      error,
    });
    try {
      await this.sqs.changeWagerVisibility(
        message.ReceiptHandle ?? '',
        delaySeconds,
      );
    } catch (visibilityError) {
      this.logger.warn({
        msg: 'could not delay message',
        error: visibilityError,
      });
    }
    return 'retry-scheduled';
  }

  private async deadLetter(
    message: Message,
    reason: string,
    error: unknown,
  ): Promise<HandleOutcome> {
    this.logger.error({
      msg: 'permanent failure, moving message to DLQ',
      reason,
      sqsMessageId: message.MessageId,
      error,
    });
    await this.sqs.sendToWagerDlq(message, reason);
    this.metrics.sqsDeadLettered.inc({ reason });
    await this.ack(message);
    return 'dead-lettered';
  }

  private async release(
    messages: Message[],
    delaySeconds: number,
  ): Promise<void> {
    await Promise.allSettled(
      messages.map((message) =>
        this.sqs.changeWagerVisibility(
          message.ReceiptHandle ?? '',
          delaySeconds,
        ),
      ),
    );
  }

  private async databaseAvailable(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.uow.transactional(async () => undefined),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('probe timeout')), 2_000);
        }),
      ]);
      this.databaseSuspect = false;
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForDatabase(): Promise<boolean> {
    let delay = this.config.consumer.unavailableBackoffMs;
    let paused = false;
    while (this.running) {
      if (await this.databaseAvailable()) {
        if (paused) {
          this.logger.log({ msg: 'database is back, consumer resumed' });
        }
        return true;
      }
      if (!paused) {
        paused = true;
        this.logger.warn({ msg: 'database unavailable, consumer paused' });
      }
      await this.sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    const signal = this.abort.signal;
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
