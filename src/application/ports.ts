import type { InboxMessage } from '../domain/inbox-message.js';
import type { OutboxMessage } from '../domain/outbox-message.js';
import type { WagerTransaction } from '../domain/wager-transaction.js';
import type { Wallet } from '../domain/wallet.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** SELECT ... FOR UPDATE: sempre relê a linha depois de travar. */
  lockById(id: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  updateBalance(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  lockById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(
    providerId: string,
    key: string,
  ): Promise<WagerTransaction | null>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerPageItem {
  seq: string;
  entry: WalletLedgerEntry;
}

export interface ReconciliationSnapshot {
  balance: string;
  currency: string;
  netAmount: string;
  entries: number;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  page(
    walletId: string,
    afterSeq: string | null,
    limit: number,
  ): Promise<LedgerPageItem[]>;
  /** Saldo guardado e soma do ledger lidos num único comando SQL. */
  reconciliationSnapshot(
    walletId: string,
  ): Promise<ReconciliationSnapshot | null>;
}

export interface InboxRepository {
  /** Grava a mensagem; se já existir, devolve a gravada antes. */
  insertIfAbsent(message: InboxMessage): Promise<InboxMessage | null>;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /** SELECT ... FOR UPDATE SKIP LOCKED dos eventos vencidos. */
  lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
  saveAll(messages: OutboxMessage[]): Promise<void>;
  oldestPendingAgeSeconds(): Promise<number>;
}

export interface TransactionScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  transactional<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export interface EventPublisher {
  /** Devolve os ids das mensagens que não foram publicadas. */
  publish(messages: OutboxMessage[]): Promise<Set<string>>;
}

export interface WagerMetrics {
  transactionSettled(status: string, kind: string): void;
  idempotentReplay(): void;
  inboxDuplicate(): void;
  concurrencyConflict(reason: string): void;
  processingDuration(seconds: number): void;
  reconciliationMismatch(): void;
  pendingReferenceAttempt(outcome: string): void;
  outboxPublished(count: number): void;
  outboxPublishFailure(): void;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export const WAGER_METRICS = Symbol('WAGER_METRICS');
export const REFERENCE_RETRY_POLICY = Symbol('REFERENCE_RETRY_POLICY');
