import {
  type EventContext,
  type IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/integration-events.js';
import { OutboxMessage } from '../domain/outbox-message.js';
import type { ReferenceLookup } from '../domain/wager-settlement.js';
import {
  type WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction.js';
import type { Wallet } from '../domain/wallet.js';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import type { TransactionScope } from './ports.js';

export function settlementEvents(
  transaction: WagerTransaction,
  wallet: Wallet | null,
  ledgerEntry: WalletLedgerEntry | null,
  ctx: EventContext,
  options: { announcePending: boolean; now: Date },
): OutboxMessage[] {
  const events: IntegrationEvent<unknown>[] = [];
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      events.push(WagerTransactionProcessed.from(transaction, ctx));
      if (wallet && ledgerEntry) {
        events.push(WalletBalanceChanged.from(wallet, ledgerEntry, ctx));
      }
      break;
    case WagerTransactionStatus.Rejected:
      events.push(WagerTransactionRejected.from(transaction, ctx));
      break;
    case WagerTransactionStatus.PendingReference:
      if (options.announcePending) {
        events.push(
          WagerTransactionPendingReference.from(transaction, ctx, options.now),
        );
      }
      break;
    default:
      break;
  }
  return events.map((event) => OutboxMessage.enqueue(event));
}

export async function lookupReference(
  scope: TransactionScope,
  transaction: WagerTransaction,
): Promise<ReferenceLookup> {
  const externalId = transaction.referenceExternalTransactionId;
  if (externalId === undefined) {
    return { transaction: null, alreadyReversed: false };
  }
  const reference = await scope.transactions.findByExternalId(
    transaction.providerId,
    externalId,
  );
  const alreadyReversed =
    reference !== null &&
    (await scope.transactions.hasProcessedReversal(reference.id));
  return { transaction: reference, alreadyReversed };
}

export async function persistSettlement(
  scope: TransactionScope,
  wallet: Wallet | null,
  ledgerEntry: WalletLedgerEntry | null,
  events: OutboxMessage[],
): Promise<void> {
  if (wallet && ledgerEntry) {
    await scope.wallets.updateBalance(wallet);
    await scope.ledger.insert(ledgerEntry);
  }
  await scope.outbox.enqueue(events);
}
