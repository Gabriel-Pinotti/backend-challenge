import type { FailureCode } from './failure-code.js';
import { newId } from './ids.js';
import type { MoneyProps } from './money.js';
import type {
  WagerTransaction,
  WagerTransactionKind,
} from './wager-transaction.js';
import type { Wallet } from './wallet.js';
import type {
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry.js';

export interface EventContext {
  correlationId: string;
  causationId?: string;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined && { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

function envelopeProps<T>(
  aggregateId: string,
  ctx: EventContext,
  occurredAt: Date,
  data: T,
): IntegrationEventProps<T> {
  return {
    eventId: newId(),
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt,
    data,
  };
}

function requireDate(value: Date | undefined, field: string): Date {
  if (!value) {
    throw new Error(`event requires ${field}`);
  }
  return value;
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    const processedAt = requireDate(transaction.processedAt, 'processedAt');
    const balanceAfter = transaction.balanceAfter;
    if (!balanceAfter) {
      throw new Error('event requires balanceAfter');
    }
    return new WagerTransactionProcessed(
      envelopeProps(transaction.walletId, ctx, processedAt, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        ...(transaction.referenceTransactionId !== undefined && {
          referenceTransactionId: transaction.referenceTransactionId,
        }),
        balanceAfter: balanceAfter.toJSON(),
        processedAt: processedAt.toISOString(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    const rejectedAt = requireDate(transaction.processedAt, 'processedAt');
    const failureCode = transaction.failureCode;
    if (!failureCode) {
      throw new Error('event requires failureCode');
    }
    return new WagerTransactionRejected(
      envelopeProps(transaction.walletId, ctx, rejectedAt, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode,
        rejectedAt: rejectedAt.toISOString(),
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged(
      envelopeProps(wallet.id, ctx, entry.createdAt, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
    occurredAt: Date,
  ): WagerTransactionPendingReference {
    const nextAttemptAt = requireDate(
      transaction.nextReferenceAttemptAt,
      'nextReferenceAttemptAt',
    );
    const reference = transaction.referenceExternalTransactionId;
    if (reference === undefined) {
      throw new Error('event requires referenceExternalTransactionId');
    }
    return new WagerTransactionPendingReference(
      envelopeProps(transaction.walletId, ctx, occurredAt, {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        referenceExternalTransactionId: reference,
        nextAttemptAt: nextAttemptAt.toISOString(),
      }),
    );
  }
}
