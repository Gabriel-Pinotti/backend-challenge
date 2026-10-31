import { defineEntity, p } from '@mikro-orm/postgresql';

export const InboxMessageRecord = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.character().length(64),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});

export const OutboxMessageRecord = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.text(),
    payload: p.json<Record<string, unknown>>().columnType('jsonb'),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime(),
    publishedAt: p.datetime().nullable(),
  },
});
