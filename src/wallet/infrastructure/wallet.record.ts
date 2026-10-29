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
    createdAt: p.datetime().defaultRaw('now()'),
    updatedAt: p.datetime().defaultRaw('now()'),
  },
  uniques: [
    {
      name: 'uq_wallets_player_currency',
      properties: ['playerId', 'currency'],
    },
  ],
  checks: [
    { name: 'ck_wallets_balance_non_negative', expression: 'balance >= 0' },
    { name: 'ck_wallets_version_positive', expression: 'version >= 1' },
  ],
});
