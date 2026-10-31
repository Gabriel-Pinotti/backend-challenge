import { describe, expect, it } from 'bun:test';
import {
  BalanceLimitExceededError,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
} from './errors.js';
import { Money } from './money.js';
import { Wallet } from './wallet.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-30T12:00:00.000Z');

function openWallet(initial: string) {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'opening-tx',
    openingEntryId: 'opening-entry',
    at,
  });
}

const movement = (amount: string, transactionId = 'tx-1') => ({
  transactionId,
  money: brl(amount),
  entryId: `entry-${transactionId}`,
  at,
});

describe('Wallet', () => {
  it('opens with version 1 and an opening credit for a positive balance', () => {
    const { wallet, openingEntry } = openWallet('1000.00');

    expect(wallet.balance.toJSON()).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe('1000.00');
    expect(openingEntry?.transactionId).toBe('opening-tx');
  });

  it('opens with zero balance and no ledger entry', () => {
    const { wallet, openingEntry } = openWallet('0.00');

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeNull();
  });

  it('debits and returns a balanced ledger entry', () => {
    const { wallet } = openWallet('100.00');

    const entry = wallet.debit(movement('80.00'));

    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('credits and increments the version', () => {
    const { wallet } = openWallet('10.00');

    const entry = wallet.credit(movement('5.50'));

    expect(wallet.balance.toJSON().amount).toBe('15.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  it('allows debiting the whole balance', () => {
    const { wallet } = openWallet('80.00');

    wallet.debit(movement('80.00'));

    expect(wallet.balance.isZero()).toBe(true);
  });

  it('never goes negative and leaves state untouched on refusal', () => {
    const { wallet } = openWallet('100.00');

    expect(() => wallet.debit(movement('100.01'))).toThrow(
      InsufficientFundsError,
    );
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('refuses movements in another currency', () => {
    const { wallet } = openWallet('100.00');
    const usd = {
      ...movement('1.00'),
      money: Money.from({ amount: '1.00', currency: 'USD' }),
    };

    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  it('refuses credits beyond what the balance column can store', () => {
    const { wallet } = openWallet('99999999999999999.99');

    expect(wallet.canCredit(brl('0.01'))).toBe(false);
    expect(() => wallet.credit(movement('0.01'))).toThrow(
      BalanceLimitExceededError,
    );
    expect(wallet.version).toBe(1);
  });

  it('refuses zero-amount movements because the ledger only stores real changes', () => {
    const { wallet } = openWallet('100.00');

    expect(() => wallet.credit(movement('0.00'))).toThrow(
      InvalidLedgerEntryError,
    );
    expect(wallet.version).toBe(1);
  });

  it('rehydrates without revalidating', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });

    expect(wallet.balance.toJSON().amount).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e',
    walletId: 'w',
    transactionId: 't',
    createdAt: at,
  };

  it('validates the arithmetic on creation', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('16.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects entries that would produce a negative balance', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('has no mutable fields', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('10.00'),
      balanceBefore: brl('15.00'),
      balanceAfter: brl('5.00'),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(
      Object.getOwnPropertyNames(WalletLedgerEntry.prototype).sort(),
    ).toEqual(['constructor', 'isBalanced']);
  });
});
