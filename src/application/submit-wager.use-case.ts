import { Inject, Injectable, Logger } from '@nestjs/common';
import { FailureCode } from '../domain/failure-code.js';
import { newId } from '../domain/ids.js';
import { InboxMessage } from '../domain/inbox-message.js';
import type { EventContext } from '../domain/integration-events.js';
import { Money } from '../domain/money.js';
import type { ReferenceRetryPolicy } from '../domain/reference-retry-policy.js';
import { settleWager } from '../domain/wager-settlement.js';
import {
  WagerTransaction,
  type WagerTransactionKind,
} from '../domain/wager-transaction.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import {
  ConcurrentWriteError,
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InboxConflictError,
} from './errors.js';
import { payloadHashOf, type WagerPayload } from './payload-hash.js';
import {
  REFERENCE_RETRY_POLICY,
  type TransactionScope,
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
import { type SubmitWagerResult, toSubmitResult } from './views.js';

export interface SubmittedWager extends WagerPayload {
  kind: WagerTransactionKind;
}

export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface SubmitWagerCommand {
  idempotencyKey: string;
  payload: SubmittedWager;
  context: EventContext;
  inbox?: InboxReceipt;
}

@Injectable()
export class SubmitWagerUseCase {
  private readonly logger = new Logger(SubmitWagerUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGER_METRICS) private readonly metrics: WagerMetrics,
    @Inject(REFERENCE_RETRY_POLICY)
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async execute(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const startedAt = performance.now();
    try {
      return await this.attempt(command);
    } catch (error) {
      if (!(error instanceof ConcurrentWriteError)) {
        throw error;
      }
      this.metrics.concurrencyConflict(error.constraint);
      this.logger.warn({
        msg: 'concurrent write, retrying as replay',
        constraint: error.constraint,
      });
      return await this.attempt(command);
    } finally {
      this.metrics.processingDuration((performance.now() - startedAt) / 1000);
    }
  }

  private attempt(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const payloadHash = payloadHashOf(command.payload);
    return this.uow.transactional(async (scope) => {
      if (command.inbox) {
        await this.registerInbox(scope, command.inbox);
      }

      const { payload } = command;
      const known = await scope.transactions.findByIdempotencyKey(
        payload.providerId,
        command.idempotencyKey,
      );
      if (known) {
        return this.replay(known, payloadHash, command.idempotencyKey);
      }

      const locked = await scope.wallets.lockById(payload.walletId);
      const wallet = locked?.playerId === payload.playerId ? locked : null;

      const raced =
        (await scope.transactions.findByIdempotencyKey(
          payload.providerId,
          command.idempotencyKey,
        )) ??
        (await scope.transactions.findByExternalId(
          payload.providerId,
          payload.externalTransactionId,
        ));
      if (raced?.idempotencyKey === command.idempotencyKey) {
        return this.replay(raced, payloadHash, command.idempotencyKey);
      }
      if (raced) {
        throw new DuplicateExternalTransactionError(
          payload.providerId,
          payload.externalTransactionId,
        );
      }

      const now = new Date();
      const transaction = WagerTransaction.create({
        id: newId(),
        providerId: payload.providerId,
        externalTransactionId: payload.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: payload.walletId,
        playerId: payload.playerId,
        roundId: payload.roundId,
        gameId: payload.gameId,
        kind: payload.kind,
        money: Money.from(payload.money),
        referenceExternalTransactionId: payload.referenceExternalTransactionId,
        createdAt: now,
      });

      let ledgerEntry: WalletLedgerEntry | null = null;
      if (wallet) {
        ({ ledgerEntry } = settleWager({
          transaction,
          wallet,
          reference: await lookupReference(scope, transaction),
          ledgerEntryId: newId(),
          retryPolicy: this.retryPolicy,
          now,
        }));
      } else {
        transaction.reject(FailureCode.WalletNotFound, undefined, now);
      }

      await scope.transactions.insert(transaction);
      await persistSettlement(
        scope,
        wallet,
        ledgerEntry,
        settlementEvents(transaction, wallet, ledgerEntry, command.context, {
          announcePending: true,
          now,
        }),
      );

      this.metrics.transactionSettled(transaction.status, transaction.kind);
      this.logger.log({
        msg: 'wager settled',
        transactionId: transaction.id,
        walletId: transaction.walletId,
        providerId: transaction.providerId,
        kind: transaction.kind,
        status: transaction.status,
        failureCode: transaction.failureCode,
      });
      return toSubmitResult(transaction, false);
    });
  }

  private async registerInbox(
    scope: TransactionScope,
    receipt: InboxReceipt,
  ): Promise<void> {
    const now = new Date();
    const message = InboxMessage.receive({ ...receipt, receivedAt: now });
    message.markProcessed(now);
    const previous = await scope.inbox.insertIfAbsent(message);
    if (!previous) {
      return;
    }
    this.metrics.inboxDuplicate();
    if (previous.payloadHash !== receipt.payloadHash) {
      throw new InboxConflictError(receipt.messageId);
    }
  }

  private replay(
    transaction: WagerTransaction,
    payloadHash: string,
    idempotencyKey: string,
  ): SubmitWagerResult {
    if (!transaction.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    this.metrics.idempotentReplay();
    return toSubmitResult(transaction, true);
  }
}
