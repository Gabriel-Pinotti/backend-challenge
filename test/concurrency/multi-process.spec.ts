import { afterAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/ids.js';
import {
  createWallet,
  postWager,
  type TestWallet,
  wagerBody,
  waitFor,
} from '../support/api.js';
import {
  balanceOf,
  closeDb,
  expectReconciled,
  ledgerCount,
  sql,
} from '../support/database.js';
import { type AppProcess, spawnApp } from '../support/process.js';
import { queueDepth, sendWagerMessage, testQueues } from '../support/sqs.js';

const running: AppProcess[] = [];

async function spawn(env: Record<string, string> = {}): Promise<AppProcess> {
  const app = await spawnApp(env);
  running.push(app);
  return app;
}

afterAll(async () => {
  await Promise.all(running.map((app) => app.stop('SIGKILL')));
  await closeDb();
});

function envelope(wallet: TestWallet, amount: string) {
  const data = wagerBody(wallet, 'BET', amount);
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

async function inboxCount(messageId: string): Promise<number> {
  const [row] = await sql<{ count: number }>(
    'select count(*)::int as count from inbox_messages where message_id = ?',
    [messageId],
  );
  return row?.count ?? 0;
}

describe('three instances at the same time', () => {
  it('keep every invariant', async () => {
    const instances = await Promise.all([spawn(), spawn(), spawn()]);
    const at = (i: number) => instances[i % instances.length]!.baseUrl;

    const duplicated = await createWallet(at(0), '100.00');
    const duplicatedBody = wagerBody(duplicated, 'BET', '10.00');
    const contended = await createWallet(at(1), '100.00');
    const contendedBodies = Array.from({ length: 30 }, () =>
      wagerBody(contended, 'BET', '10.00'),
    );

    const [sameBet, contention] = await Promise.all([
      Promise.all(
        Array.from({ length: 50 }, (_, i) => postWager(at(i), duplicatedBody)),
      ),
      Promise.all(
        [...contendedBodies, ...contendedBodies].map((body, i) =>
          postWager(at(i), body),
        ),
      ),
    ]);

    expect(sameBet.filter((r) => r.status === 201)).toHaveLength(1);
    expect(sameBet.filter((r) => r.status === 200)).toHaveLength(49);
    expect(await ledgerCount(duplicated.id, 'DEBIT')).toBe(1);
    expect(await balanceOf(duplicated.id)).toBe('90.00');

    const accepted = new Set(
      contention
        .filter(
          (r) =>
            r.status === 201 ||
            (r.status === 200 && r.body.status === 'PROCESSED'),
        )
        .map((r) => r.body.transactionId),
    );
    expect(accepted.size).toBe(10);
    expect(contention.every((r) => [200, 201, 422].includes(r.status))).toBe(
      true,
    );
    expect(await ledgerCount(contended.id, 'DEBIT')).toBe(10);
    expect(await balanceOf(contended.id)).toBe('0.00');
    await expectReconciled(duplicated.id);
    await expectReconciled(contended.id);
  }, 60_000);
});

describe('process crashes', () => {
  it('a worker killed after the commit and before the ack does not apply the message twice', async () => {
    const wallet = await createWallet((await spawn()).baseUrl, '100.00');
    const message = envelope(wallet, '30.00');
    const doomed = await spawn({
      SQS_CONSUMER_ENABLED: 'true',
      FAULT_EXIT_AFTER_COMMIT_BEFORE_ACK: 'true',
    });

    await sendWagerMessage(message);
    expect(await doomed.process.exited).toBe(86);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    expect(await queueDepth((await testQueues()).wagers)).toBe(1);

    const replacement = await spawn({ SQS_CONSUMER_ENABLED: 'true' });
    await waitFor(
      async () => queueDepth((await testQueues()).wagers),
      (depth) => depth === 0,
      20_000,
    );

    const metrics = await fetch(`${replacement.baseUrl}/metrics`).then((r) =>
      r.text(),
    );
    expect(metrics).toMatch(/inbox_duplicates_total 1/);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    expect(await inboxCount(message.messageId)).toBe(1);
    await expectReconciled(wallet.id);
  }, 60_000);

  it('SIGTERM stops gracefully without losing received messages', async () => {
    const wallet = await createWallet((await spawn()).baseUrl, '100.00');
    const consumer = await spawn({ SQS_CONSUMER_ENABLED: 'true' });
    const messages = Array.from({ length: 5 }, () => envelope(wallet, '1.00'));

    await Promise.all(messages.map((message) => sendWagerMessage(message)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stoppedAt = Date.now();
    const exitCode = await consumer.stop('SIGTERM');
    expect([0, 143]).toContain(exitCode);
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);

    await spawn({ SQS_CONSUMER_ENABLED: 'true' });
    await waitFor(
      () => ledgerCount(wallet.id, 'DEBIT'),
      (count) => count === 5,
      30_000,
    );
    await waitFor(
      async () => queueDepth((await testQueues()).wagers),
      (depth) => depth === 0,
      20_000,
    );
    expect(await balanceOf(wallet.id)).toBe('95.00');
    await expectReconciled(wallet.id);
  }, 60_000);

  it('a restart in the middle of traffic ends consistent once providers retry', async () => {
    const first = await spawn();
    const wallets = await Promise.all(
      Array.from({ length: 4 }, () => createWallet(first.baseUrl, '100.00')),
    );
    const bodies = wallets.flatMap((wallet) =>
      Array.from({ length: 15 }, () => wagerBody(wallet, 'BET', '10.00')),
    );

    const inFlight = Promise.allSettled(
      bodies.map((body) => postWager(first.baseUrl, body)),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await first.stop('SIGKILL');
    await inFlight;

    const second = await spawn();
    const retried = await Promise.all(
      bodies.map((body) => postWager(second.baseUrl, body)),
    );

    expect(retried.every((r) => [200, 201, 422].includes(r.status))).toBe(true);
    for (const wallet of wallets) {
      expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(10);
      expect(await balanceOf(wallet.id)).toBe('0.00');
      await expectReconciled(wallet.id);
    }
    const [duplicates] = await sql<{ count: number }>(
      `select count(*)::int as count from (
         select provider_id, external_transaction_id from wager_transactions
          where wallet_id in (?) group by 1, 2 having count(*) > 1) d`,
      [wallets.map((wallet) => wallet.id)],
    );
    expect(duplicates?.count).toBe(0);
  }, 60_000);
});
