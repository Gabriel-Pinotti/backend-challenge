import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import {
  EVENT_PUBLISHER,
  type EventPublisher,
  UNIT_OF_WORK,
  WAGER_METRICS,
} from '../../src/application/ports.js';
import { PublishOutboxUseCase } from '../../src/application/publish-outbox.use-case.js';
import type { OutboxMessage } from '../../src/domain/outbox-message.js';
import { createWallet, postWager, wagerBody, waitFor } from '../support/api.js';
import { type TestApp, startApp } from '../support/app.js';
import { sql } from '../support/database.js';
import { receiveAll, testQueues } from '../support/sqs.js';

let app: TestApp;

async function discardBacklogFromOtherSuites(): Promise<void> {
  await sql(
    'update outbox_messages set published_at = now() where published_at is null',
  );
}

beforeAll(async () => {
  app = await startApp();
  await discardBacklogFromOtherSuites();
});

afterAll(async () => {
  await app.close();
});

async function outboxIds(walletId: string): Promise<string[]> {
  const rows = await sql<{ id: string }>(
    'select id from outbox_messages where aggregate_id = ? order by occurred_at',
    [walletId],
  );
  return rows.map((row) => row.id);
}

async function unpublished(ids: string[]): Promise<number> {
  const [row] = await sql<{ count: number }>(
    'select count(*)::int as count from outbox_messages where published_at is null and id in (?)',
    [ids],
  );
  return row?.count ?? 0;
}

function publisherWith(eventPublisher: EventPublisher): PublishOutboxUseCase {
  return new PublishOutboxUseCase(
    app.app.get(UNIT_OF_WORK),
    eventPublisher,
    app.app.get(WAGER_METRICS),
  );
}

async function collectEvents(
  ids: string[],
  timeoutMs = 15_000,
): Promise<Map<string, Message>> {
  const { events } = await testQueues();
  const wanted = new Set(ids);
  const found = new Map<string, Message>();
  await waitFor(
    async () => {
      for (const message of await receiveAll(events)) {
        const eventId = JSON.parse(message.Body ?? '{}').eventId as string;
        if (wanted.has(eventId)) {
          found.set(eventId, message);
        }
      }
      return found.size;
    },
    (size) => size === wanted.size,
    timeoutMs,
    0,
  );
  return found;
}

describe('transactional outbox', () => {
  it('publishes committed events to SQS grouped by wallet and deduplicated by eventId', async () => {
    const wallet = await createWallet(app.baseUrl, '100.00');
    await postWager(app.baseUrl, wagerBody(wallet, 'BET', '10.00'));
    const ids = await outboxIds(wallet.id);
    const publisher = app.app.get(PublishOutboxUseCase);

    await waitFor(
      async () => {
        await publisher.publishBatch(100);
        return unpublished(ids);
      },
      (count) => count === 0,
    );

    const messages = await collectEvents(ids);
    const balanceChanged = [...messages.values()].find(
      (message) =>
        message.MessageAttributes?.eventType?.StringValue ===
          'WalletBalanceChanged' &&
        JSON.parse(message.Body ?? '{}').data.direction === 'DEBIT',
    );
    expect(ids).toHaveLength(4);
    expect(balanceChanged?.Attributes?.MessageGroupId).toBe(wallet.id);
    expect(JSON.parse(balanceChanged!.Body!)).toMatchObject({
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      version: 1,
      data: {
        walletId: wallet.id,
        direction: 'DEBIT',
        money: { amount: '10.00', currency: 'BRL' },
      },
    });
  }, 20_000);

  it('lets a second publisher work while the first one holds its batch', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 4 }, () => createWallet(app.baseUrl, '10.00')),
    );
    const ids = (
      await Promise.all(wallets.map((wallet) => outboxIds(wallet.id)))
    ).flat();
    let releaseFirst: () => void = () => {};
    let firstHolding: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      firstHolding = resolve;
    });
    const stuck = publisherWith({
      async publish() {
        firstHolding();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return new Set<string>();
      },
    });
    const seenBySecond: string[] = [];
    const second = publisherWith({
      async publish(messages) {
        seenBySecond.push(...messages.map((message) => message.id));
        return new Set<string>();
      },
    });

    const first = stuck.publishBatch(2);
    await holding;
    const startedAt = Date.now();
    const publishedBySecond = await second.publishBatch(2);
    const waited = Date.now() - startedAt;
    releaseFirst();
    await first;

    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(publishedBySecond).toBe(2);
    expect(waited).toBeLessThan(1_000);
  }, 20_000);

  it('never lets two concurrent publishers publish the same event', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 8 }, () => createWallet(app.baseUrl, '50.00')),
    );
    await Promise.all(
      wallets.map((wallet) =>
        postWager(app.baseUrl, wagerBody(wallet, 'BET', '5.00')),
      ),
    );
    const ids = (
      await Promise.all(wallets.map((wallet) => outboxIds(wallet.id)))
    ).flat();
    const sends = new Map<string, number>();
    const real = app.app.get<EventPublisher>(EVENT_PUBLISHER);
    const recording: EventPublisher = {
      async publish(messages: OutboxMessage[]) {
        for (const message of messages) {
          sends.set(message.id, (sends.get(message.id) ?? 0) + 1);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return real.publish(messages);
      },
    };
    const first = publisherWith(recording);
    const second = publisherWith(recording);

    await waitFor(
      async () => {
        await Promise.all([first.publishBatch(4), second.publishBatch(4)]);
        return unpublished(ids);
      },
      (count) => count === 0,
      30_000,
      0,
    );

    expect(ids).toHaveLength(32);
    expect(ids.every((id) => sends.get(id) === 1)).toBe(true);
    expect([...sends.values()].every((count) => count === 1)).toBe(true);
  }, 40_000);

  it('reschedules failed publications with backoff instead of losing them', async () => {
    const wallet = await createWallet(app.baseUrl, '10.00');
    const ids = await outboxIds(wallet.id);
    const failing = publisherWith({
      async publish(messages) {
        return new Set(
          messages
            .filter((message) => ids.includes(message.id))
            .map((message) => message.id),
        );
      },
    });

    await waitFor(
      async () => {
        await failing.publishBatch(100);
        const [row] = await sql<{ attempts: number }>(
          'select min(attempts)::int as attempts from outbox_messages where id in (?)',
          [ids],
        );
        return row?.attempts ?? 0;
      },
      (attempts) => attempts >= 1,
    );

    const [failed] = await sql<{
      attempts: number;
      due_in: number;
      published_at: Date | null;
    }>(
      `select attempts, extract(epoch from next_attempt_at - now())::float8 as due_in, published_at
         from outbox_messages where id = ?`,
      [ids[0]],
    );
    expect(failed?.attempts).toBe(1);
    expect(failed?.due_in).toBeGreaterThan(0);
    expect(failed?.published_at).toBeNull();

    const healthy = app.app.get(PublishOutboxUseCase);
    await waitFor(
      async () => {
        await healthy.publishBatch(100);
        return unpublished(ids);
      },
      (count) => count === 0,
      10_000,
      200,
    );
  }, 20_000);

  it('is published by another instance when the committing one dies first', async () => {
    const committing = await startApp((config) => {
      config.outbox.enabled = false;
    });
    const wallet = await createWallet(committing.baseUrl, '100.00');
    await postWager(committing.baseUrl, wagerBody(wallet, 'BET', '10.00'));
    await committing.close();
    const ids = await outboxIds(wallet.id);
    expect(await unpublished(ids)).toBe(ids.length);

    const survivor = await startApp((config) => {
      config.outbox.enabled = true;
    });
    try {
      await waitFor(
        () => unpublished(ids),
        (count) => count === 0,
        15_000,
      );
      expect((await collectEvents(ids)).size).toBe(ids.length);
    } finally {
      await survivor.close();
    }
  }, 40_000);
});
