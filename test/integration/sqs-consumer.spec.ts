import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { newId } from '../../src/domain/ids.js';
import mikroOrmConfig from '../../src/mikro-orm.config.js';
import {
  createWallet,
  postWager,
  type TestWallet,
  wagerBody,
  waitFor,
} from '../support/api.js';
import { type TestApp, startApp } from '../support/app.js';
import {
  balanceOf,
  expectReconciled,
  ledgerCount,
  sql,
} from '../support/database.js';
import {
  queueDepth,
  receiveAll,
  sendRaw,
  sendWagerMessage,
  testQueues,
} from '../support/sqs.js';

let app: TestApp;

beforeAll(async () => {
  app = await startApp((config) => {
    config.consumer.enabled = true;
    config.database.lockTimeoutMs = 300;
  });
});

afterAll(async () => {
  await app.close();
});

function envelope(
  wallet: TestWallet,
  kind: string,
  amount: string,
  overrides: Record<string, unknown> = {},
) {
  const data = wagerBody(wallet, kind, amount, overrides);
  return {
    messageId: `msg-${newId()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      ...data,
      idempotencyKey: `${data.providerId}:${data.externalTransactionId}`,
    },
  };
}

async function transactionsOf(
  walletId: string,
  kind = 'BET',
): Promise<{ status: string; failure_code: string | null }[]> {
  return sql(
    'select status, failure_code from wager_transactions where wallet_id = ? and kind = ?',
    [walletId, kind],
  );
}

async function inboxCount(messageId: string): Promise<number> {
  const [row] = await sql<{ count: number }>(
    'select count(*)::int as count from inbox_messages where message_id = ?',
    [messageId],
  );
  return row?.count ?? 0;
}

const deadLetters = new Map<string, string>();

async function deadLetterReason(
  body: string,
  timeoutMs = 15_000,
): Promise<string> {
  const { dlq } = await testQueues();
  return waitFor(
    async () => {
      for (const message of await receiveAll(dlq)) {
        deadLetters.set(
          message.Body ?? '',
          message.MessageAttributes?.deadLetterReason?.StringValue ?? 'REDRIVE',
        );
      }
      return deadLetters.get(body);
    },
    (reason) => reason !== undefined,
    timeoutMs,
    0,
  ) as Promise<string>;
}

describe('wager queue consumer', () => {
  it('applies a message with the same use case and acks after commit', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    const message = envelope(wallet, 'BET', '25.00');

    await sendWagerMessage(message);

    await waitFor(
      () => balanceOf(wallet.id),
      (balance) => balance === '75.00',
    );
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(await queueDepth((await testQueues()).wagers)).toBe(0);
    await expectReconciled(wallet.id);
  });

  it('deduplicates redelivered messages through the inbox', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    const message = envelope(wallet, 'BET', '10.00');

    await sendWagerMessage(message);
    await waitFor(
      () => balanceOf(wallet.id),
      (balance) => balance === '90.00',
    );
    await sendWagerMessage(message);
    await sendWagerMessage(message);

    await waitFor(
      async () => queueDepth((await testQueues()).wagers),
      (depth) => depth === 0,
    );
    const metrics = await fetch(`${app.baseUrl}/metrics`).then((r) => r.text());
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
    expect(metrics).toMatch(/inbox_duplicates_total [2-9]/);
  });

  it('shares idempotency with the HTTP entrypoint', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    const message = envelope(wallet, 'BET', '10.00');
    const { idempotencyKey, ...body } = message.data;
    const http = await postWager(app.baseUrl, body, idempotencyKey);

    await sendWagerMessage(message);

    await waitFor(
      () => inboxCount(message.messageId),
      (count) => count === 1,
    );
    expect(http.status).toBe(201);
    expect(await transactionsOf(wallet.id)).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('90.00');
  });

  it('acks business rejections without retrying', async () => {
    const wallet = await createWallet(app.baseUrl, '5.00');
    const message = envelope(wallet, 'BET', '10.00');

    await sendWagerMessage(message);

    await waitFor(
      () => transactionsOf(wallet.id),
      (rows) => rows.length === 1,
    );
    await waitFor(
      async () => queueDepth((await testQueues()).wagers),
      (depth) => depth === 0,
    );
    expect(await transactionsOf(wallet.id)).toEqual([
      { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' },
    ]);
    await expectReconciled(wallet.id);
  });

  it('acks a credit that would exceed the storable balance', async () => {
    const wallet = await createWallet(app.baseUrl, '99999999999999999.99');
    const message = envelope(wallet, 'WIN', '1.00');

    await sendWagerMessage(message);

    await waitFor(
      () => transactionsOf(wallet.id, 'WIN'),
      (rows) => rows.length === 1,
    );
    await waitFor(
      async () => queueDepth((await testQueues()).wagers),
      (depth) => depth === 0,
    );
    expect(await transactionsOf(wallet.id, 'WIN')).toEqual([
      { status: 'REJECTED', failure_code: 'BALANCE_LIMIT_EXCEEDED' },
    ]);
  });

  it('dead-letters a messageId reused with different content', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    const original = envelope(wallet, 'BET', '10.00');
    const reused = {
      ...envelope(wallet, 'BET', '20.00'),
      messageId: original.messageId,
    };

    await sendWagerMessage(original);
    await waitFor(
      () => balanceOf(wallet.id),
      (balance) => balance === '90.00',
    );
    await sendWagerMessage(reused);

    expect(await deadLetterReason(JSON.stringify(reused))).toBe(
      'MESSAGE_ID_REUSED',
    );
    expect(await balanceOf(wallet.id)).toBe('90.00');
    await expectReconciled(wallet.id);
  });

  describe('permanent failures go straight to the DLQ', () => {
    it('for broken JSON', async () => {
      const { wagers } = await testQueues();
      const body = `{"messageId": "${newId()}", broken`;

      await sendRaw(wagers, body, 'broken');

      expect(await deadLetterReason(body)).toBe('INVALID_MESSAGE');
    });

    it('for OPENING submitted from outside', async () => {
      const wallet = await createWallet(app.baseUrl, '5.00');
      const message = envelope(wallet, 'OPENING', '10.00');

      await sendWagerMessage(message);

      expect(await deadLetterReason(JSON.stringify(message))).toBe(
        'INVALID_MESSAGE',
      );
      expect(await balanceOf(wallet.id)).toBe('5.00');
    });

    it('for an idempotency key reused with another payload', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const original = envelope(wallet, 'BET', '10.00');
      const tampered = {
        ...original,
        messageId: `msg-${newId()}`,
        data: { ...original.data, money: { amount: '99.00', currency: 'BRL' } },
      };

      await sendWagerMessage(original);
      await waitFor(
        () => balanceOf(wallet.id),
        (balance) => balance === '90.00',
      );
      await sendWagerMessage(tampered);

      expect(await deadLetterReason(JSON.stringify(tampered))).toBe(
        'IDEMPOTENCY_KEY_REUSED',
      );
      expect(await balanceOf(wallet.id)).toBe('90.00');
    });
  });

  describe('transient failures', () => {
    async function holdWalletLock(
      walletId: string,
      holdMs: number,
    ): Promise<void> {
      const holder = await MikroORM.init({
        ...mikroOrmConfig,
        debug: false,
        pool: { max: 1 },
      });
      try {
        await holder.em.fork().transactional(async (em) => {
          await em.execute('select id from wallets where id = ? for update', [
            walletId,
          ]);
          await new Promise((resolve) => setTimeout(resolve, holdMs));
        });
      } finally {
        await holder.close(true);
      }
    }

    it('are retried with backoff until they succeed', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const message = envelope(wallet, 'BET', '10.00');
      const lock = holdWalletLock(wallet.id, 1_500);
      await new Promise((resolve) => setTimeout(resolve, 100));

      await sendWagerMessage(message);
      await lock;

      await waitFor(
        () => balanceOf(wallet.id),
        (balance) => balance === '90.00',
        15_000,
      );
      const metrics = await fetch(`${app.baseUrl}/metrics`).then((r) =>
        r.text(),
      );
      expect(metrics).toMatch(/sqs_retries_total [1-9]/);
      expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    }, 20_000);

    it('end up in the DLQ after maxReceiveCount without side effects', async () => {
      const wallet = await createWallet(app.baseUrl, '100.00');
      const message = envelope(wallet, 'BET', '10.00');
      const lock = holdWalletLock(wallet.id, 15_000);
      await new Promise((resolve) => setTimeout(resolve, 100));

      await sendWagerMessage(message);

      expect(await deadLetterReason(JSON.stringify(message), 20_000)).toBe(
        'REDRIVE',
      );
      await lock;
      expect(await balanceOf(wallet.id)).toBe('100.00');
      expect(await inboxCount(message.messageId)).toBe(0);
    }, 30_000);
  });
});
