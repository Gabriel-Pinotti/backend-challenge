import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './errors.js';
import { Money } from './money.js';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  it.each([
    '',
    'NaN',
    'Infinity',
    '-Infinity',
    '1e5',
    '1E5',
    '-1.00',
    '+1.00',
    '1.001',
    '1,00',
    '25',
    '25.5',
    '.50',
    '1.',
    ' 1.00',
    '1.00 ',
    '0x10',
    '123456789012345678.00',
  ])('rejects amount %p', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
  });

  it.each([1, null, undefined, 1.5])(
    'rejects non-string amount %p',
    (amount) => {
      expect(() =>
        Money.from({ amount: amount as unknown as string, currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    },
  );

  it.each(['', 'brl', 'BR', 'BRLL', '123', 'ZZZ', 'ABC'])(
    'rejects currency %p',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(
        InvalidMoneyError,
      );
    },
  );

  it.each(['0.00', '25.00', '0.01', '99999999999999999.99'])(
    'accepts %p and serializes it unchanged',
    (amount) => {
      expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
    },
  );

  it('adds without floating point drift', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON()).toEqual({
      amount: '0.30',
      currency: 'BRL',
    });
  });

  it('keeps exact precision at the largest supported values', () => {
    const max = brl('99999999999999999.99');
    expect(max.add(brl('0.01')).toJSON().amount).toBe('100000000000000000.00');
    expect(max.subtract(brl('0.01')).toJSON().amount).toBe(
      '99999999999999999.98',
    );
  });

  it('subtracts into negative values and reports the sign', () => {
    const result = brl('10.00').subtract(brl('10.01'));
    expect(result.isNegative()).toBe(true);
    expect(result.toJSON().amount).toBe('-0.01');
  });

  it('is immutable', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    a.subtract(brl('5.00'));
    a.negate();
    expect(a.toJSON().amount).toBe('10.00');
  });

  it('never serializes negative zero', () => {
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    expect(Money.zero('BRL').negate().isNegative()).toBe(false);
  });

  it('compares values', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
  });

  it('formats as string with currency', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });

  describe('currency conflicts', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    it('refuses to add, subtract or compare different currencies', () => {
      expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    });

    it('treats the same amount in different currencies as different', () => {
      expect(brl('1.00').equals(usd)).toBe(false);
    });
  });
});
