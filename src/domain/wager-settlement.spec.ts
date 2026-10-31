import { describe, expect, it } from 'bun:test';
import { FailureCode } from './failure-code.js';
import { Money } from './money.js';
import { ReferenceRetryPolicy } from './reference-retry-policy.js';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from './wager-transaction.js';
import { type ReferenceLookup, settleWager } from './wager-settlement.js';
import { Wallet } from './wallet.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

const at = new Date('2026-10-30T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const policy = new ReferenceRetryPolicy({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
});
const noReference: ReferenceLookup = {
  transaction: null,
  alreadyReversed: false,
};

let sequence = 0;

function walletWith(balance: string): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(balance),
    openingTransactionId: 'opening',
    openingEntryId: 'opening-entry',
    at,
  }).wallet;
}

function wager(
  kind: Kind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  sequence += 1;
  return WagerTransaction.create({
    id: `tx-${sequence}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${sequence}`,
    idempotencyKey: `provider-a:ext-${sequence}`,
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    createdAt: at,
    ...overrides,
  });
}

function settle(
  transaction: WagerTransaction,
  wallet: Wallet,
  reference: ReferenceLookup = noReference,
) {
  return settleWager({
    transaction,
    wallet,
    reference,
    ledgerEntryId: `entry-${transaction.id}`,
    retryPolicy: policy,
    now: at,
  });
}

function processed(
  kind: Kind,
  amount: string,
  wallet: Wallet,
): WagerTransaction {
  const tx = wager(kind, amount);
  settle(tx, wallet);
  expect(tx.status).toBe(Status.Processed);
  return tx;
}

function reversalOf(
  reference: WagerTransaction,
  kind: Kind.Refund | Kind.Rollback,
  amount = reference.money.toJSON().amount,
): WagerTransaction {
  return wager(kind, amount, {
    referenceExternalTransactionId: reference.externalTransactionId,
  });
}

const found = (transaction: WagerTransaction, alreadyReversed = false) => ({
  transaction,
  alreadyReversed,
});

describe('settleWager', () => {
  describe('BET', () => {
    it('debits and creates one DEBIT entry', () => {
      const wallet = walletWith('100.00');
      const bet = wager(Kind.Bet, '80.00');

      const { ledgerEntry } = settle(bet, wallet);

      expect(bet.status).toBe(Status.Processed);
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toJSON().amount).toBe('20.00');
      expect(bet.balanceAfter?.toJSON().amount).toBe('20.00');
    });

    it('is rejected with INSUFFICIENT_FUNDS and no ledger', () => {
      const wallet = walletWith('20.00');
      const bet = wager(Kind.Bet, '80.00');

      const { ledgerEntry } = settle(bet, wallet);

      expect(bet.status).toBe(Status.Rejected);
      expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(ledgerEntry).toBeNull();
      expect(wallet.balance.toJSON().amount).toBe('20.00');
      expect(wallet.version).toBe(1);
      expect(bet.balanceAfter?.toJSON().amount).toBe('20.00');
    });
  });

  it('WIN credits, optionally referencing the BET of the same round', () => {
    const wallet = walletWith('100.00');
    const bet = processed(Kind.Bet, '10.00', wallet);
    const win = wager(Kind.Win, '30.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const { ledgerEntry } = settle(win, wallet, found(bet));

    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('120.00');
  });

  it('LOSS records the result without moving the balance', () => {
    const wallet = walletWith('100.00');

    const loss = wager(Kind.Loss, '10.00');
    const { ledgerEntry } = settle(loss, wallet);

    expect(loss.status).toBe(Status.Processed);
    expect(ledgerEntry).toBeNull();
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  describe('REFUND', () => {
    it('credits back a processed BET', () => {
      const wallet = walletWith('100.00');
      const bet = processed(Kind.Bet, '40.00', wallet);
      const refund = reversalOf(bet, Kind.Refund);

      const { ledgerEntry } = settle(refund, wallet, found(bet));

      expect(refund.status).toBe(Status.Processed);
      expect(refund.referenceTransactionId).toBe(bet.id);
      expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
    });

    it('only references BETs', () => {
      const wallet = walletWith('100.00');
      const win = processed(Kind.Win, '40.00', wallet);
      const refund = reversalOf(win, Kind.Refund);

      settle(refund, wallet, found(win));

      expect(refund.failureCode).toBe(FailureCode.ReferenceInvalidKind);
    });

    it('happens only once', () => {
      const wallet = walletWith('100.00');
      const bet = processed(Kind.Bet, '40.00', wallet);
      const refund = reversalOf(bet, Kind.Refund);

      settle(refund, wallet, found(bet, true));

      expect(refund.failureCode).toBe(FailureCode.AlreadyReversed);
      expect(wallet.balance.toJSON().amount).toBe('60.00');
    });

    it('must match the referenced amount', () => {
      const wallet = walletWith('100.00');
      const bet = processed(Kind.Bet, '40.00', wallet);
      const refund = reversalOf(bet, Kind.Refund, '39.99');

      settle(refund, wallet, found(bet));

      expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    });
  });

  describe('ROLLBACK', () => {
    it('of a BET credits', () => {
      const wallet = walletWith('100.00');
      const bet = processed(Kind.Bet, '25.00', wallet);
      const rollback = reversalOf(bet, Kind.Rollback);

      const { ledgerEntry } = settle(rollback, wallet, found(bet));

      expect(ledgerEntry?.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
    });

    it('of a WIN debits', () => {
      const wallet = walletWith('100.00');
      const win = processed(Kind.Win, '50.00', wallet);
      const rollback = reversalOf(win, Kind.Rollback);

      const { ledgerEntry } = settle(rollback, wallet, found(win));

      expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
    });

    it('of a REFUND debits', () => {
      const wallet = walletWith('100.00');
      const bet = processed(Kind.Bet, '30.00', wallet);
      const refund = reversalOf(bet, Kind.Refund);
      settle(refund, wallet, found(bet));
      const rollback = reversalOf(refund, Kind.Rollback);

      const { ledgerEntry } = settle(rollback, wallet, found(refund));

      expect(ledgerEntry?.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.toJSON().amount).toBe('70.00');
    });

    it('that would go negative is rejected with its own failure code', () => {
      const wallet = walletWith('50.00');
      const win = processed(Kind.Win, '50.00', wallet);
      processed(Kind.Bet, '100.00', wallet);
      const rollback = reversalOf(win, Kind.Rollback);

      const { ledgerEntry } = settle(rollback, wallet, found(win));

      expect(rollback.status).toBe(Status.Rejected);
      expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(ledgerEntry).toBeNull();
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('cannot target a LOSS', () => {
      const wallet = walletWith('100.00');
      const loss = processed(Kind.Loss, '10.00', wallet);
      const rollback = reversalOf(loss, Kind.Rollback);

      settle(rollback, wallet, found(loss));

      expect(rollback.failureCode).toBe(FailureCode.ReferenceInvalidKind);
    });
  });

  describe('reference validation', () => {
    it.each([
      ['player', { playerId: 'player-2' }],
      ['round', { roundId: 'round-2' }],
      ['provider', { providerId: 'provider-b' }],
      ['wallet', { walletId: 'wallet-2' }],
      ['currency', { money: Money.from({ amount: '10.00', currency: 'USD' }) }],
    ])('rejects a reference from another %s', (_, override) => {
      const wallet = walletWith('100.00');
      const bet = wager(Kind.Bet, '10.00', override);
      bet.markProcessed(undefined, brl('90.00'), at);
      const refund = reversalOf(bet, Kind.Refund);

      settle(refund, wallet, found(bet));

      expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    });

    it('rejects a reference that was not processed', () => {
      const wallet = walletWith('5.00');
      const bet = wager(Kind.Bet, '10.00');
      settle(bet, wallet);
      const refund = reversalOf(bet, Kind.Refund);

      settle(refund, wallet, found(bet));

      expect(bet.status).toBe(Status.Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    });

    it('waits while the reference itself is still pending', () => {
      const wallet = walletWith('100.00');
      const bet = processed(Kind.Bet, '10.00', wallet);
      const refund = reversalOf(bet, Kind.Refund);
      settle(refund, wallet, noReference);
      const rollback = reversalOf(refund, Kind.Rollback);

      settle(rollback, wallet, found(refund));

      expect(refund.status).toBe(Status.PendingReference);
      expect(rollback.status).toBe(Status.PendingReference);
    });
  });

  describe('missing reference', () => {
    it('becomes PENDING_REFERENCE with backoff', () => {
      const wallet = walletWith('100.00');
      const refund = wager(Kind.Refund, '10.00', {
        referenceExternalTransactionId: 'not-yet',
      });

      const { ledgerEntry } = settle(refund, wallet);

      expect(refund.status).toBe(Status.PendingReference);
      expect(refund.nextReferenceAttemptAt).toEqual(
        new Date(at.getTime() + 1_000),
      );
      expect(ledgerEntry).toBeNull();
    });

    it('is retried with growing delays and rejected after the limit', () => {
      const wallet = walletWith('100.00');
      const refund = wager(Kind.Refund, '10.00', {
        referenceExternalTransactionId: 'never',
      });

      settle(refund, wallet);
      settle(refund, wallet);
      expect(refund.nextReferenceAttemptAt).toEqual(
        new Date(at.getTime() + 2_000),
      );
      settle(refund, wallet);
      expect(refund.nextReferenceAttemptAt).toEqual(
        new Date(at.getTime() + 4_000),
      );
      settle(refund, wallet);

      expect(refund.status).toBe(Status.Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    });

    it('is processed once the reference arrives', () => {
      const wallet = walletWith('100.00');
      const bet = wager(Kind.Bet, '10.00');
      const refund = reversalOf(bet, Kind.Refund);
      settle(refund, wallet);
      expect(refund.status).toBe(Status.PendingReference);

      settle(bet, wallet);
      settle(refund, wallet, found(bet));

      expect(refund.status).toBe(Status.Processed);
      expect(wallet.balance.toJSON().amount).toBe('100.00');
    });
  });

  it('rejects a currency different from the wallet', () => {
    const wallet = walletWith('100.00');
    const bet = wager(Kind.Bet, '10.00', {
      money: Money.from({ amount: '10.00', currency: 'USD' }),
    });

    const { ledgerEntry } = settle(bet, wallet);

    expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(bet.balanceAfter).toBeUndefined();
    expect(ledgerEntry).toBeNull();
    expect(wallet.version).toBe(1);
  });

  it('refuses a WIN or LOSS on a BET that was already reversed', () => {
    const wallet = walletWith('100.00');
    const bet = processed(Kind.Bet, '10.00', wallet);
    const win = wager(Kind.Win, '500.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    settle(win, wallet, found(bet, true));

    expect(win.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(wallet.balance.toJSON().amount).toBe('90.00');
  });

  describe('storage limit', () => {
    it('rejects credits that would not fit numeric(19,2)', () => {
      const wallet = walletWith('99999999999999999.99');
      const win = wager(Kind.Win, '0.01');

      const { ledgerEntry } = settle(win, wallet);

      expect(win.status).toBe(Status.Rejected);
      expect(win.failureCode).toBe(FailureCode.BalanceLimitExceeded);
      expect(ledgerEntry).toBeNull();
      expect(wallet.version).toBe(1);
    });

    it('still accepts a credit that lands exactly on the limit', () => {
      const wallet = walletWith('99999999999999999.98');

      settle(wager(Kind.Win, '0.01'), wallet);

      expect(wallet.balance.toJSON().amount).toBe('99999999999999999.99');
    });
  });

  it('processes zero-amount wagers without touching the ledger', () => {
    const wallet = walletWith('100.00');
    const win = wager(Kind.Win, '0.00');

    const { ledgerEntry } = settle(win, wallet);

    expect(win.status).toBe(Status.Processed);
    expect(ledgerEntry).toBeNull();
    expect(wallet.version).toBe(1);
  });
});
