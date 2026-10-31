import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG, type AppConfig, loadConfig } from '../../src/config.js';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger.js';
import { createWallet, postWager, request, wagerBody } from '../support/api.js';
import { prepareDatabase } from '../support/database.js';
import { testQueues } from '../support/sqs.js';

interface RunningApp {
  app: INestApplication;
  baseUrl: string;
}

async function boot(
  configure: (config: AppConfig) => void,
  lines: string[] = [],
): Promise<RunningApp> {
  await Promise.all([prepareDatabase(), testQueues()]);
  const config = loadConfig();
  configure(config);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();
  const app = moduleRef.createNestApplication({
    logger: new JsonLogger((line) => lines.push(line)),
  });
  await app.listen(0);
  const { port } = app.getHttpServer().address() as { port: number };
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

const lines: string[] = [];
let healthy: RunningApp;

beforeAll(async () => {
  healthy = await boot(() => {}, lines);
});

afterAll(async () => {
  await healthy.app.close();
});

describe('structured logs', () => {
  it('carry the correlation fields and no money values', async () => {
    const wallet = await createWallet(healthy.baseUrl, '1000.00');
    const body = wagerBody(wallet, 'BET', '37.42');

    const response = await request(
      healthy.baseUrl,
      'POST',
      '/wagering/transactions',
      {
        body,
        headers: {
          'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
          'X-Correlation-Id': 'corr-observability-1',
        },
      },
    );

    const records = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const settled = records.find(
      (record) =>
        record.msg === 'wager settled' &&
        record.correlationId === 'corr-observability-1',
    );
    expect(response.status).toBe(201);
    expect(settled).toMatchObject({
      level: 'info',
      correlationId: 'corr-observability-1',
      transactionId: response.body.transactionId,
      walletId: wallet.id,
      providerId: body.providerId,
    });
    expect(lines.join('\n')).not.toContain('37.42');
    expect(lines.join('\n')).not.toContain('962.58');
  });
});

describe('correlation id', () => {
  it('is echoed back, or generated when absent', async () => {
    const given = await fetch(`${healthy.baseUrl}/health/live`, {
      headers: { 'X-Correlation-Id': 'abc-123' },
    });
    const generated = await fetch(`${healthy.baseUrl}/health/live`);
    const injected = await fetch(`${healthy.baseUrl}/health/live`, {
      headers: { 'X-Correlation-Id': 'has spaces and\ttabs' },
    });

    expect(given.headers.get('x-correlation-id')).toBe('abc-123');
    expect(generated.headers.get('x-correlation-id')).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(injected.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('metrics', () => {
  it('expose the series the challenge asks for', async () => {
    const wallet = await createWallet(healthy.baseUrl, '10.00');
    const body = wagerBody(wallet, 'BET', '1.00');
    await postWager(healthy.baseUrl, body);
    await postWager(healthy.baseUrl, body);

    const text = await fetch(`${healthy.baseUrl}/metrics`).then((r) =>
      r.text(),
    );

    for (const series of [
      'wager_transactions_total{status="PROCESSED",kind="BET"}',
      'idempotent_replays_total',
      'inbox_duplicates_total',
      'concurrency_conflicts_total',
      'sqs_retries_total',
      'sqs_dlq_total',
      'sqs_dlq_messages',
      'outbox_lag_seconds',
      'wager_processing_seconds_bucket',
      'reconciliation_mismatches_total',
    ]) {
      expect(text).toContain(series);
    }
    expect(text).toMatch(/^idempotent_replays_total [1-9]/m);
  });
});

describe('health checks', () => {
  it('report not ready, but alive, when SQS is unreachable', async () => {
    const broken = await boot((config) => {
      config.sqs.endpoint = 'http://127.0.0.1:9';
      config.consumer.enabled = false;
    });
    try {
      const live = await request(broken.baseUrl, 'GET', '/health/live');
      const ready = await request(broken.baseUrl, 'GET', '/health/ready');

      expect(live.status).toBe(200);
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({
        status: 'unavailable',
        checks: { postgres: 'up', sqs: 'down' },
      });
    } finally {
      await broken.app.close();
    }
  });

  it('report ready when every dependency answers', async () => {
    const ready = await request(healthy.baseUrl, 'GET', '/health/ready');

    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ postgres: 'up', sqs: 'up' });
  });
});
