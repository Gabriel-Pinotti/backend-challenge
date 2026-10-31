import { LedgerEntryRecord } from './ledger-entry.record.js';
import {
  InboxMessageRecord,
  OutboxMessageRecord,
} from './messaging.records.js';
import { WagerTransactionRecord } from './wager-transaction.record.js';
import { WalletRecord } from './wallet.record.js';

export {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
};

export const ALL_RECORDS = [
  WalletRecord,
  WagerTransactionRecord,
  LedgerEntryRecord,
  InboxMessageRecord,
  OutboxMessageRecord,
];
