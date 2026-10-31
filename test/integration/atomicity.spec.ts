import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/application/ports.js';
import { newId } from '../../src/domain/ids.js';
import { InboxMessage } from '../../src/domain/inbox-message.js';
import { WalletBalanceChanged } from '../../src/domain/integration-events.js';
import { Money } from '../../src/domain/money.js';
import { OutboxMessage } from '../../src/domain/outbox-message.js';
import { WagerTransaction } from '../../src/domain/wager-transaction.js';
import { Wallet } from '../../src/domain/wallet.js';
import { type TestApp, startApp } from '../support/app.js';
import { rejectionOf } from '../support/assertions.js';
import { sql } from '../support/database.js';

let app: TestApp;
let uow: UnitOfWork;

beforeAll(async () => {
  app = await startApp();
  uow = app.app.get(UNIT_OF_WORK);
});

afterAll(async () => {
  await app.close();
});

function openedWallet() {
  const now = new Date();
  const walletId = newId();
  const money = Money.from({ amount: '50.00', currency: 'BRL' });
  const opening = WagerTransaction.opening({
    id: newId(),
    walletId,
    playerId: newId(),
    money,
    createdAt: now,
  });
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: opening.playerId,
    initialBalance: money,
    openingTransactionId: opening.id,
    openingEntryId: newId(),
    at: now,
  });
  opening.markProcessed(undefined, wallet.balance, now);
  return { wallet, opening, openingEntry: openingEntry!, now };
}

async function persistedRows(walletId: string, messageId: string) {
  const [counts] = await sql<Record<string, number>>(
    `select (select count(*)::int from wallets where id = ?) as wallets,
            (select count(*)::int from wager_transactions where wallet_id = ?) as transactions,
            (select count(*)::int from wallet_ledger_entries where wallet_id = ?) as ledger,
            (select count(*)::int from outbox_messages where aggregate_id = ?) as outbox,
            (select count(*)::int from inbox_messages where message_id = ?) as inbox`,
    [walletId, walletId, walletId, walletId, messageId],
  );
  return counts;
}

describe('transactional atomicity', () => {
  it('commits wallet, transaction, ledger, inbox and outbox together', async () => {
    const { wallet, opening, openingEntry, now } = openedWallet();
    const messageId = newId();

    await uow.transactional(async (scope) => {
      await scope.inbox.insertIfAbsent(
        InboxMessage.receive({
          messageId,
          consumerName: 'atomicity',
          payloadHash: 'a'.repeat(64),
          receivedAt: now,
        }),
      );
      await scope.wallets.insert(wallet);
      await scope.transactions.insert(opening);
      await scope.ledger.insert(openingEntry);
      await scope.outbox.enqueue([
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, openingEntry, {
            correlationId: 'c',
          }),
        ),
      ]);
    });

    expect(await persistedRows(wallet.id, messageId)).toEqual({
      wallets: 1,
      transactions: 1,
      ledger: 1,
      outbox: 1,
      inbox: 1,
    });
  });

  it.each([
    [
      'an application error',
      () => Promise.reject(new Error('boom after every write')),
    ],
    [
      'a constraint violation in the last statement',
      (
        scope: Parameters<Parameters<UnitOfWork['transactional']>[0]>[0],
        wallet: Wallet,
      ) => scope.wallets.insert(wallet),
    ],
  ])('rolls everything back on %s', async (_, fail) => {
    const { wallet, opening, openingEntry, now } = openedWallet();
    const messageId = newId();

    const outcome = uow.transactional(async (scope) => {
      await scope.inbox.insertIfAbsent(
        InboxMessage.receive({
          messageId,
          consumerName: 'atomicity',
          payloadHash: 'a'.repeat(64),
          receivedAt: now,
        }),
      );
      await scope.wallets.insert(wallet);
      await scope.transactions.insert(opening);
      await scope.ledger.insert(openingEntry);
      await scope.outbox.enqueue([
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, openingEntry, {
            correlationId: 'c',
          }),
        ),
      ]);
      await fail(scope, wallet);
    });

    expect(await rejectionOf(outcome)).toBeInstanceOf(Error);
    expect(await persistedRows(wallet.id, messageId)).toEqual({
      wallets: 0,
      transactions: 0,
      ledger: 0,
      outbox: 0,
      inbox: 0,
    });
  });
});
