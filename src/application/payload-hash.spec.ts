import { describe, expect, it } from 'bun:test';
import {
  canonicalJson,
  payloadHashOf,
  type WagerPayload,
} from './payload-hash.js';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(
      canonicalJson({ b: 2, a: { d: [1, { z: 1, y: 2 }], c: undefined } }),
    ).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":2}');
  });
});

describe('payloadHashOf', () => {
  it('is a stable sha-256 hex digest', () => {
    expect(payloadHashOf(payload)).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHashOf(payload)).toBe(payloadHashOf({ ...payload }));
  });

  it('ignores key order', () => {
    const reordered = Object.fromEntries(
      Object.entries(payload).reverse(),
    ) as unknown as WagerPayload;

    expect(payloadHashOf(reordered)).toBe(payloadHashOf(payload));
  });

  it.each([
    ['provider', { providerId: 'provider-b' }],
    ['external id', { externalTransactionId: 'transaction-124' }],
    ['player', { playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2' }],
    ['wallet', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['round', { roundId: 'round-988' }],
    ['game', { gameId: 'other-game' }],
    ['kind', { kind: 'WIN' }],
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['reference', { referenceExternalTransactionId: 'x' }],
  ])('changes when the %s diverges', (_, change) => {
    expect(payloadHashOf({ ...payload, ...change })).not.toBe(
      payloadHashOf(payload),
    );
  });
});
