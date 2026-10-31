import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Request } from 'express';
import {
  PROVIDER_IDENTITY,
  type ProviderIdentityPort,
} from '../../src/interfaces/http/provider-identity.js';
import { request, wagerBody } from '../support/api.js';
import { type TestApp, startApp } from '../support/app.js';

const headerIdentity: ProviderIdentityPort = {
  enabled: true,
  async resolve(req: Request) {
    const providerId = req.header('x-test-provider');
    return providerId ? { providerId } : null;
  },
};

let app: TestApp;

beforeAll(async () => {
  app = await startApp(() => {}, [
    { provide: PROVIDER_IDENTITY, useValue: headerIdentity },
  ]);
});

afterAll(async () => {
  await app.close();
});

const as = (providerId: string) => ({ 'x-test-provider': providerId });

async function walletFor(providerId: string) {
  const playerId = crypto.randomUUID();
  const response = await request(app.baseUrl, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
    headers: as(providerId),
  });
  return { id: response.body.id as string, playerId };
}

describe('provider identity when authentication is enabled', () => {
  it('rejects requests without an identity', async () => {
    const response = await request(
      app.baseUrl,
      'GET',
      `/wallets/${crypto.randomUUID()}`,
    );

    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('keeps health and metrics open', async () => {
    expect((await request(app.baseUrl, 'GET', '/health/live')).status).toBe(
      200,
    );
    expect((await fetch(`${app.baseUrl}/metrics`)).status).toBe(200);
  });

  it('refuses a body that claims another provider', async () => {
    const wallet = await walletFor('provider-a');
    const body = wagerBody(wallet, 'BET', '1.00', { providerId: 'provider-b' });

    const response = await request(
      app.baseUrl,
      'POST',
      '/wagering/transactions',
      {
        body,
        headers: { ...as('provider-a'), 'Idempotency-Key': 'k-1' },
      },
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PROVIDER_MISMATCH');
  });

  it("hides another provider's transactions", async () => {
    const wallet = await walletFor('provider-a');
    const body = wagerBody(wallet, 'BET', '1.00', { providerId: 'provider-a' });
    const created = await request(
      app.baseUrl,
      'POST',
      '/wagering/transactions',
      {
        body,
        headers: {
          ...as('provider-a'),
          'Idempotency-Key': `k-${crypto.randomUUID()}`,
        },
      },
    );
    const path = `/wagering/transactions/${created.body.transactionId}`;

    const own = await request(app.baseUrl, 'GET', path, {
      headers: as('provider-a'),
    });
    const foreign = await request(app.baseUrl, 'GET', path, {
      headers: as('provider-b'),
    });
    const foreignByExternalId = await request(
      app.baseUrl,
      'GET',
      `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
      { headers: as('provider-b') },
    );

    expect(created.status).toBe(201);
    expect(own.status).toBe(200);
    expect(foreign.status).toBe(404);
    expect(foreignByExternalId.status).toBe(403);
  });
});
