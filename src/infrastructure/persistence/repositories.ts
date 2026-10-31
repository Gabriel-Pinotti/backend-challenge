import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import type {
  InboxRepository,
  LedgerPageItem,
  LedgerRepository,
  OutboxRepository,
  ReconciliationSnapshot,
  TransactionScope,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports.js';
import { InboxMessage } from '../../domain/inbox-message.js';
import type { OutboxMessage } from '../../domain/outbox-message.js';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction.js';
import type { Wallet } from '../../domain/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.js';
import { ConcurrentWriteError } from '../../application/errors.js';
import {
  fromLedgerEntry,
  fromOutboxMessage,
  fromWagerTransaction,
  fromWallet,
  toLedgerEntry,
  toOutboxMessage,
  toWagerTransaction,
  toWallet,
  transactionState,
} from './mappers.js';
import {
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records/index.js';

const READ = { disableIdentityMap: true } as const;
const LOCK = {
  disableIdentityMap: true,
  lockMode: LockMode.PESSIMISTIC_WRITE,
} as const;

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRecord, { id }, READ);
    return row ? toWallet(row) : null;
  }

  async lockById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRecord, { id }, LOCK);
    return row ? toWallet(row) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, fromWallet(wallet));
  }

  async updateBalance(wallet: Wallet): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: wallet.version - 1 },
      {
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (updated !== 1) {
      throw new ConcurrentWriteError('wallets.version');
    }
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRecord, { id }, READ);
    return row ? toWagerTransaction(row) : null;
  }

  async lockById(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionRecord, { id }, LOCK);
    return row ? toWagerTransaction(row) : null;
  }

  async findByIdempotencyKey(
    providerId: string,
    key: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, idempotencyKey: key },
      READ,
    );
    return row ? toWagerTransaction(row) : null;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      READ,
    );
    return row ? toWagerTransaction(row) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: {
        $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
      },
    });
    return count > 0;
  }

  async findDuePendingReferenceIds(
    now: Date,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: { $lte: now },
      },
      {
        ...READ,
        fields: ['id'],
        orderBy: { nextReferenceAttemptAt: 'asc' },
        limit,
      },
    );
    return rows.map((row) => row.id);
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(
      WagerTransactionRecord,
      fromWagerTransaction(transaction),
    );
  }

  async update(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      transactionState(transaction),
    );
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, fromLedgerEntry(entry));
  }

  async page(
    walletId: string,
    afterSeq: string | null,
    limit: number,
  ): Promise<LedgerPageItem[]> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      afterSeq === null ? { walletId } : { walletId, seq: { $gt: afterSeq } },
      { ...READ, orderBy: { seq: 'asc' }, limit },
    );
    return rows.map((row) => ({
      seq: String(row.seq),
      entry: toLedgerEntry(row),
    }));
  }

  async reconciliationSnapshot(
    walletId: string,
  ): Promise<ReconciliationSnapshot | null> {
    const [row] = await this.em.execute<
      { balance: string; currency: string; net: string; entries: number }[]
    >(
      `select w.balance::text as balance,
              w.currency,
              coalesce(l.net, 0)::numeric(19, 2)::text as net,
              coalesce(l.entries, 0)::int as entries
         from wallets w
         left join lateral (
           select sum(case when direction = 'CREDIT' then amount else -amount end) as net,
                  count(*) as entries
             from wallet_ledger_entries
            where wallet_id = w.id
         ) l on true
        where w.id = ?`,
      [walletId],
    );
    return row
      ? {
          balance: row.balance,
          currency: row.currency,
          netAmount: row.net,
          entries: row.entries,
        }
      : null;
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<InboxMessage | null> {
    const inserted = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
    );
    if (inserted.length > 0) {
      return null;
    }
    const [existing] = await this.em.execute<
      {
        payload_hash: string;
        received_at: Date;
        processed_at: Date | null;
      }[]
    >(
      `select payload_hash, received_at, processed_at
         from inbox_messages
        where consumer_name = ? and message_id = ?`,
      [message.consumerName, message.messageId],
    );
    if (!existing) {
      throw new ConcurrentWriteError('inbox_messages');
    }
    return InboxMessage.rehydrate({
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: existing.payload_hash,
      receivedAt: existing.received_at,
      processedAt: existing.processed_at ?? undefined,
    });
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.em.insertMany(
      OutboxMessageRecord,
      messages.map(fromOutboxMessage),
    );
  }

  async lockDueBatch(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        disableIdentityMap: true,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        orderBy: { occurredAt: 'asc' },
        limit,
      },
    );
    return rows.map(toOutboxMessage);
  }

  async saveAll(messages: OutboxMessage[]): Promise<void> {
    const publishedByTime = new Map<number, string[]>();
    for (const message of messages) {
      if (message.publishedAt) {
        const ids = publishedByTime.get(message.publishedAt.getTime()) ?? [];
        ids.push(message.id);
        publishedByTime.set(message.publishedAt.getTime(), ids);
      } else {
        await this.update(message);
      }
    }
    for (const [time, ids] of publishedByTime) {
      await this.em.nativeUpdate(
        OutboxMessageRecord,
        { id: { $in: ids } },
        { publishedAt: new Date(time) },
      );
    }
  }

  private async update(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
        publishedAt: message.publishedAt ?? null,
      },
    );
  }

  async oldestPendingAgeSeconds(): Promise<number> {
    const [row] = await this.em.execute<{ lag: number | null }[]>(
      `select extract(epoch from (now() - min(occurred_at)))::float8 as lag
         from outbox_messages
        where published_at is null`,
    );
    return Math.max(row?.lag ?? 0, 0);
  }
}

export function createTransactionScope(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
