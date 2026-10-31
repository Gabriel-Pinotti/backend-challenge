import { InvalidWagerTransactionError } from './errors.js';
import { FailureCode } from './failure-code.js';
import type { ReferenceRetryPolicy } from './reference-retry-policy.js';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';
import type { Wallet } from './wallet.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface ReferenceLookup {
  transaction: WagerTransaction | null;
  alreadyReversed: boolean;
}

export interface SettleWagerInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference: ReferenceLookup;
  ledgerEntryId: string;
  retryPolicy: ReferenceRetryPolicy;
  now: Date;
}

export interface SettlementOutcome {
  ledgerEntry: WalletLedgerEntry | null;
}

const ALLOWED_REFERENCE_KINDS: Partial<
  Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>
> = {
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Loss]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

type ReferenceCheck =
  | { type: 'none' }
  | { type: 'missing' }
  | { type: 'invalid'; code: FailureCode }
  | { type: 'valid'; transaction: WagerTransaction };

export function settleWager(input: SettleWagerInput): SettlementOutcome {
  const { transaction, wallet, now } = input;
  if (transaction.walletId !== wallet.id) {
    throw new InvalidWagerTransactionError(
      'transaction does not belong to this wallet',
    );
  }

  if (transaction.money.currency !== wallet.currency) {
    transaction.reject(FailureCode.CurrencyMismatch, undefined, now);
    return { ledgerEntry: null };
  }

  const check = checkReference(transaction, input.reference);
  if (check.type === 'missing') {
    awaitReference(input);
    return { ledgerEntry: null };
  }
  if (check.type === 'invalid') {
    transaction.reject(check.code, wallet.balance, now);
    return { ledgerEntry: null };
  }
  const reference = check.type === 'valid' ? check.transaction : null;

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, wallet.balance, now);
    return { ledgerEntry: null };
  }

  const direction = transaction.ledgerDirectionFor(reference ?? undefined);
  if (
    direction === LedgerDirection.Debit &&
    !wallet.canDebit(transaction.money)
  ) {
    const code = transaction.requiresReference()
      ? FailureCode.ReversalInsufficientFunds
      : FailureCode.InsufficientFunds;
    transaction.reject(code, wallet.balance, now);
    return { ledgerEntry: null };
  }
  if (
    direction === LedgerDirection.Credit &&
    !wallet.canCredit(transaction.money)
  ) {
    transaction.reject(FailureCode.BalanceLimitExceeded, wallet.balance, now);
    return { ledgerEntry: null };
  }

  const movement = {
    transactionId: transaction.id,
    money: transaction.money,
    entryId: input.ledgerEntryId,
    at: now,
  };
  const ledgerEntry =
    direction === LedgerDirection.Debit
      ? wallet.debit(movement)
      : wallet.credit(movement);
  transaction.markProcessed(reference?.id, wallet.balance, now);
  return { ledgerEntry };
}

function checkReference(
  transaction: WagerTransaction,
  lookup: ReferenceLookup,
): ReferenceCheck {
  if (transaction.referenceExternalTransactionId === undefined) {
    return { type: 'none' };
  }
  const reference = lookup.transaction;
  if (!reference) {
    return { type: 'missing' };
  }
  const sameContext =
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.roundId === transaction.roundId &&
    reference.money.currency === transaction.money.currency;
  if (!sameContext) {
    return { type: 'invalid', code: FailureCode.ReferenceMismatch };
  }
  if (!ALLOWED_REFERENCE_KINDS[transaction.kind]?.has(reference.kind)) {
    return { type: 'invalid', code: FailureCode.ReferenceInvalidKind };
  }
  if (!reference.isTerminal()) {
    return { type: 'missing' };
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return { type: 'invalid', code: FailureCode.ReferenceNotProcessed };
  }
  if (
    transaction.requiresReference() &&
    !reference.money.equals(transaction.money)
  ) {
    return { type: 'invalid', code: FailureCode.ReferenceAmountMismatch };
  }
  if (lookup.alreadyReversed) {
    return { type: 'invalid', code: FailureCode.AlreadyReversed };
  }
  return { type: 'valid', transaction: reference };
}

function awaitReference(input: SettleWagerInput): void {
  const { transaction, wallet, retryPolicy, now } = input;
  const attempts =
    transaction.status === WagerTransactionStatus.PendingReference
      ? transaction.referenceAttempts + 1
      : 0;
  if (retryPolicy.isExhausted(attempts)) {
    transaction.reject(FailureCode.ReferenceNotFound, wallet.balance, now);
    return;
  }
  transaction.markPendingReference(
    wallet.balance,
    retryPolicy.nextAttemptAt(attempts, now),
  );
}
