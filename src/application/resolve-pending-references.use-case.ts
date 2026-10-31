import { Inject, Injectable, Logger } from '@nestjs/common';
import { FailureCode } from '../domain/failure-code.js';
import { newId } from '../domain/ids.js';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy.js';
import { settleWager } from '../domain/wager-settlement.js';
import { WagerTransactionStatus } from '../domain/wager-transaction.js';
import { TransientError } from './errors.js';
import {
  REFERENCE_RETRY_POLICY,
  UNIT_OF_WORK,
  type UnitOfWork,
  WAGER_METRICS,
  type WagerMetrics,
} from './ports.js';
import {
  lookupReference,
  persistSettlement,
  settlementEvents,
} from './settlement-events.js';

@Injectable()
export class ResolvePendingReferencesUseCase {
  private readonly logger = new Logger(ResolvePendingReferencesUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGER_METRICS) private readonly metrics: WagerMetrics,
    @Inject(REFERENCE_RETRY_POLICY)
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async runOnce(limit: number): Promise<number> {
    const ids = await this.uow.transactional((scope) =>
      scope.transactions.findDuePendingReferenceIds(new Date(), limit),
    );
    let resolved = 0;
    for (const id of ids) {
      try {
        await this.resolve(id);
        resolved += 1;
      } catch (error) {
        if (error instanceof TransientError) {
          this.logger.warn({
            msg: 'pending reference attempt will be retried',
            transactionId: id,
            error,
          });
          continue;
        }
        this.logger.error({
          msg: 'pending reference attempt failed permanently',
          transactionId: id,
          error,
        });
        await this.markFailed(id).catch((markError: unknown) => {
          this.logger.error({
            msg: 'could not mark transaction as failed',
            transactionId: id,
            error: markError,
          });
        });
      }
    }
    return resolved;
  }

  private markFailed(transactionId: string): Promise<void> {
    return this.uow.transactional(async (scope) => {
      const transaction = await scope.transactions.lockById(transactionId);
      if (transaction?.status !== WagerTransactionStatus.PendingReference) {
        return;
      }
      transaction.fail(FailureCode.ProcessingFailed, new Date());
      await scope.transactions.update(transaction);
      this.metrics.pendingReferenceAttempt(transaction.status);
      this.metrics.transactionSettled(transaction.status, transaction.kind);
    });
  }

  private resolve(transactionId: string): Promise<void> {
    return this.uow.transactional(async (scope) => {
      const candidate = await scope.transactions.findById(transactionId);
      if (candidate?.status !== WagerTransactionStatus.PendingReference) {
        return;
      }
      const wallet = await scope.wallets.lockById(candidate.walletId);
      const transaction = await scope.transactions.lockById(transactionId);
      const now = new Date();
      if (
        !wallet ||
        transaction?.status !== WagerTransactionStatus.PendingReference ||
        (transaction.nextReferenceAttemptAt ?? now) > now
      ) {
        return;
      }

      const { ledgerEntry } = settleWager({
        transaction,
        wallet,
        reference: await lookupReference(scope, transaction),
        ledgerEntryId: newId(),
        retryPolicy: this.retryPolicy,
        now,
      });

      await scope.transactions.update(transaction);
      await persistSettlement(
        scope,
        wallet,
        ledgerEntry,
        settlementEvents(
          transaction,
          wallet,
          ledgerEntry,
          { correlationId: newId(), causationId: transaction.id },
          { announcePending: false, now },
        ),
      );

      this.metrics.pendingReferenceAttempt(transaction.status);
      if (transaction.isTerminal()) {
        this.metrics.transactionSettled(transaction.status, transaction.kind);
      }
      this.logger.log({
        msg: 'pending reference attempt',
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        status: transaction.status,
        failureCode: transaction.failureCode,
        attempts: transaction.referenceAttempts,
      });
    });
  }
}
