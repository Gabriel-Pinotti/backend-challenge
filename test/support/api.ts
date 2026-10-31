import { newId } from '../../src/domain/ids.js';

export interface ApiResponse<T = Record<string, any>> {
  status: number;
  body: T;
  headers: Headers;
}

export interface TestWallet {
  id: string;
  playerId: string;
}

export async function request<T = Record<string, any>>(
  baseUrl: string,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined && { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

export async function createWallet(
  baseUrl: string,
  amount: string,
  currency = 'BRL',
): Promise<TestWallet> {
  const playerId = newId();
  const response = await request(baseUrl, 'POST', '/wallets', {
    body: { playerId, initialBalance: { amount, currency } },
  });
  if (response.status !== 201) {
    throw new Error(
      `could not create wallet: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return { id: response.body.id, playerId };
}

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wagerBody(
  wallet: TestWallet,
  kind: string,
  amount: string,
  overrides: Partial<WagerBody> = {},
): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

export function keyOf(body: WagerBody): string {
  return `${body.providerId}:${body.externalTransactionId}`;
}

export function postWager(
  baseUrl: string,
  body: WagerBody,
  idempotencyKey: string = keyOf(body),
): Promise<ApiResponse> {
  return request(baseUrl, 'POST', '/wagering/transactions', {
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!done(value)) {
    if (Date.now() > deadline) {
      throw new Error(
        `condition not met in ${timeoutMs}ms; last value: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await probe();
  }
  return value;
}
