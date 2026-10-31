import { defineEntity, p } from '@mikro-orm/postgresql';

export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.character().length(64),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.text(),
    amount: p.decimal('string').precision(19).scale(2),
    currency: p.character().length(3),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.text(),
    failureCode: p.text().nullable(),
    balanceAfter: p.decimal('string').precision(19).scale(2).nullable(),
    referenceAttempts: p.integer(),
    nextReferenceAttemptAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
