import { describe, expect, it } from 'bun:test';
import { InboxMessage } from './inbox-message.js';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from './integration-events.js';
import { Money } from './money.js';
import { OutboxMessage } from './outbox-message.js';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction.js';
import { Wallet } from './wallet.js';

const at = new Date('2026-10-30T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const ctx = { correlationId: 'corr-1', causationId: 'msg-1' };

function balanceChanged() {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
    openingTransactionId: 'opening',
    openingEntryId: 'opening-entry',
    at,
  });
  const entry = wallet.debit({
    transactionId: 'tx-1',
    money: brl('25.00'),
    entryId: 'entry-1',
    at,
  });
  return WalletBalanceChanged.from(wallet, entry, ctx);
}

describe('integration events', () => {
  it('serializes a versioned envelope with money as decimal strings', () => {
    const json = balanceChanged().toJSON();

    expect(json).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: at.toISOString(),
      data: {
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(json.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps the event type on the class', () => {
    const tx = WagerTransaction.create({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'k',
      payloadHash: 'a'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Loss,
      money: brl('5.00'),
      createdAt: at,
    });
    tx.markProcessed(undefined, brl('100.00'), at);

    const event = WagerTransactionProcessed.from(tx, ctx);

    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.toJSON().data.kind).toBe(WagerTransactionKind.Loss);
  });
});

describe('OutboxMessage', () => {
  it('enqueues an event as a pending, due message', () => {
    const event = balanceChanged();
    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe(event.eventId);
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual(JSON.parse(JSON.stringify(event.toJSON())));
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at)).toBe(true);
  });

  it('backs off exponentially up to a cap', () => {
    const message = OutboxMessage.enqueue(balanceChanged());
    const delays: number[] = [];

    for (let i = 0; i < 8; i++) {
      message.scheduleRetry(at);
      delays.push(message.nextAttemptAt!.getTime() - at.getTime());
    }

    expect(message.attempts).toBe(8);
    expect(delays).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
    expect(message.isDue(at)).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 60_000))).toBe(true);
  });

  it('stops being pending once published', () => {
    const message = OutboxMessage.enqueue(balanceChanged());

    message.markPublished(at);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(at)).toBe(false);
    expect(message.publishedAt).toEqual(at);
  });
});

describe('InboxMessage', () => {
  it('tracks processing', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'consumer',
      payloadHash: 'h',
      receivedAt: at,
    });

    expect(message.isProcessed()).toBe(false);
    message.markProcessed(at);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(at);
  });
});
