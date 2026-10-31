import { describe, expect, it } from 'bun:test';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from './errors.js';
import { FailureCode } from './failure-code.js';
import { Money } from './money.js';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

const at = new Date('2026-10-30T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function props(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    createdAt: at,
    ...overrides,
  };
}

describe('WagerTransaction', () => {
  it('is born PENDING', () => {
    const tx = WagerTransaction.create(props());

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  it('refuses OPENING from outside', () => {
    expect(() =>
      WagerTransaction.create(props({ kind: WagerTransactionKind.Opening })),
    ).toThrow(InvalidWagerTransactionError);
  });

  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s requires a reference',
    (kind) => {
      expect(() => WagerTransaction.create(props({ kind }))).toThrow(
        InvalidWagerTransactionError,
      );
    },
  );

  it('BET cannot reference another transaction', () => {
    expect(() =>
      WagerTransaction.create(props({ referenceExternalTransactionId: 'x' })),
    ).toThrow(InvalidWagerTransactionError);
  });

  it.each([WagerTransactionKind.Win, WagerTransactionKind.Loss])(
    '%s may reference a BET',
    (kind) => {
      const tx = WagerTransaction.create(
        props({ kind, referenceExternalTransactionId: 'bet-1' }),
      );
      expect(tx.referenceExternalTransactionId).toBe('bet-1');
    },
  );

  it('builds the internal OPENING transaction', () => {
    const tx = WagerTransaction.opening({
      id: 'open-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('100.00'),
      createdAt: at,
    });

    expect(tx.kind).toBe(WagerTransactionKind.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  describe('transitions', () => {
    it('processes and records the observed balance', () => {
      const tx = WagerTransaction.create(props());

      tx.markProcessed(undefined, brl('90.00'), at);

      expect(tx.status).toBe(WagerTransactionStatus.Processed);
      expect(tx.balanceAfter?.toJSON().amount).toBe('90.00');
      expect(tx.processedAt).toEqual(at);
    });

    it('counts reference attempts after the first wait', () => {
      const tx = WagerTransaction.create(
        props({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'bet-1',
        }),
      );

      tx.markPendingReference(brl('5.00'), at);
      expect(tx.referenceAttempts).toBe(0);
      tx.markPendingReference(brl('5.00'), at);
      expect(tx.referenceAttempts).toBe(1);
      expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    });

    it.each([
      [
        'processed',
        (tx: WagerTransaction) => tx.markProcessed(undefined, brl('1.00'), at),
      ],
      [
        'rejected',
        (tx: WagerTransaction) =>
          tx.reject(FailureCode.InsufficientFunds, brl('1.00'), at),
      ],
      [
        'failed',
        (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed, at),
      ],
    ])('a %s transaction never changes again', (_, terminate) => {
      const tx = WagerTransaction.create(props());
      terminate(tx);

      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, brl('1.00'), at)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markPendingReference(brl('1.00'), at)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() =>
        tx.reject(FailureCode.CurrencyMismatch, undefined, at),
      ).toThrow(InvalidTransactionStateError);
      expect(() => tx.fail(FailureCode.ProcessingFailed, at)).toThrow(
        InvalidTransactionStateError,
      );
    });
  });

  describe('domain queries', () => {
    it('LOSS and zero amounts do not affect the balance', () => {
      expect(
        WagerTransaction.create(
          props({ kind: WagerTransactionKind.Loss }),
        ).affectsBalance(),
      ).toBe(false);
      expect(
        WagerTransaction.create(props({ money: brl('0.00') })).affectsBalance(),
      ).toBe(false);
      expect(WagerTransaction.create(props()).affectsBalance()).toBe(true);
    });

    it('compares payload hashes', () => {
      const tx = WagerTransaction.create(props());

      expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
      expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
    });

    it('derives ROLLBACK direction from its reference', () => {
      const bet = WagerTransaction.create(props());
      const win = WagerTransaction.create(
        props({ id: 'win', kind: WagerTransactionKind.Win }),
      );
      const rollback = WagerTransaction.create(
        props({
          id: 'rb',
          kind: WagerTransactionKind.Rollback,
          referenceExternalTransactionId: 'ext-1',
        }),
      );

      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
      expect(() => rollback.ledgerDirectionFor()).toThrow(
        InvalidWagerTransactionError,
      );
    });
  });
});
