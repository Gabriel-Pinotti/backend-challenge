import { Inject, Injectable } from '@nestjs/common';
import { InvalidCursorError, NotFoundError } from './errors.js';
import { UNIT_OF_WORK, type UnitOfWork } from './ports.js';
import {
  type LedgerPageView,
  type TransactionView,
  toLedgerEntryView,
  toTransactionView,
  toWalletView,
  type WalletView,
} from './views.js';

const SEQ_PATTERN = /^[1-9]\d{0,18}$/;
const MAX_SEQ = 9223372036854775807n;

export function encodeCursor(seq: string): string {
  return Buffer.from(`seq:${seq}`).toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const seq = decoded.startsWith('seq:') ? decoded.slice(4) : '';
  if (
    !SEQ_PATTERN.test(seq) ||
    BigInt(seq) > MAX_SEQ ||
    encodeCursor(seq) !== cursor
  ) {
    throw new InvalidCursorError();
  }
  return seq;
}

@Injectable()
export class WalletQueries {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  getWallet(walletId: string): Promise<WalletView> {
    return this.uow.transactional(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) {
        throw new NotFoundError(`wallet ${walletId} not found`);
      }
      return toWalletView(wallet);
    });
  }

  getLedger(
    walletId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<LedgerPageView> {
    const afterSeq = cursor === undefined ? null : decodeCursor(cursor);
    return this.uow.transactional(async (scope) => {
      if (!(await scope.wallets.findById(walletId))) {
        throw new NotFoundError(`wallet ${walletId} not found`);
      }
      const rows = await scope.ledger.page(walletId, afterSeq, limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        walletId,
        items: page.map((row) => toLedgerEntryView(row.entry)),
        nextCursor: rows.length > limit && last ? encodeCursor(last.seq) : null,
      };
    });
  }

  getTransaction(transactionId: string): Promise<TransactionView> {
    return this.uow.transactional(async (scope) => {
      const transaction = await scope.transactions.findById(transactionId);
      if (!transaction) {
        throw new NotFoundError(`transaction ${transactionId} not found`);
      }
      return toTransactionView(transaction);
    });
  }

  getTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.uow.transactional(async (scope) => {
      const transaction = await scope.transactions.findByExternalId(
        providerId,
        externalTransactionId,
      );
      if (!transaction) {
        throw new NotFoundError(
          `transaction ${externalTransactionId} from ${providerId} not found`,
        );
      }
      return toTransactionView(transaction);
    });
  }
}
