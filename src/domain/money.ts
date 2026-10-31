import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './errors.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const ExactDecimal = Decimal.clone({ precision: 40 });

const AMOUNT_PATTERN = /^\d{1,17}\.\d{2}$/;
const MAX_AMOUNT = new ExactDecimal('99999999999999999.99');
const ISO_4217 = new Set(Intl.supportedValuesOf('currency'));

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (
      typeof props.amount !== 'string' ||
      !AMOUNT_PATTERN.test(props.amount)
    ) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with exactly 2 decimal places',
      );
    }
    Money.assertCurrency(props.currency);
    return new Money(new ExactDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new ExactDecimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isWithinStorageLimit(): boolean {
    return this.value.abs().lte(MAX_AMOUNT);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    return this.value.isZero() ? '0.00' : this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !ISO_4217.has(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code');
    }
  }
}
