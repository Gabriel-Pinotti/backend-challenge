import { defineEntity, p } from '@mikro-orm/postgresql';

export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.character().length(3),
    balance: p.decimal('string').precision(19).scale(2),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
