import { defineEntity, p } from '@mikro-orm/postgresql';

export const LedgerEntryRecord = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    seq: p.bigint('string').generated('identity').nullable(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.text(),
    amount: p.decimal('string').precision(19).scale(2),
    currency: p.character().length(3),
    balanceBefore: p.decimal('string').precision(19).scale(2),
    balanceAfter: p.decimal('string').precision(19).scale(2),
    createdAt: p.datetime(),
  },
});
