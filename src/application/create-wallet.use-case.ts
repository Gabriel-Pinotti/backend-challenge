import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId } from '../domain/ids.js';
import type { EventContext } from '../domain/integration-events.js';
import { Money, type MoneyProps } from '../domain/money.js';
import { WagerTransaction } from '../domain/wager-transaction.js';
import { Wallet } from '../domain/wallet.js';
import { ConcurrentWriteError, WalletAlreadyExistsError } from './errors.js';
import { UNIT_OF_WORK, type UnitOfWork } from './ports.js';
import { settlementEvents } from './settlement-events.js';
import { toWalletView, type WalletView } from './views.js';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  context: EventContext;
}

@Injectable()
export class CreateWalletUseCase {
  private readonly logger = new Logger(CreateWalletUseCase.name);

  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    try {
      return await this.uow.transactional(async (scope) => {
        const now = new Date();
        const walletId = newId();
        const opening = WagerTransaction.opening({
          id: newId(),
          walletId,
          playerId: command.playerId,
          money: initialBalance,
          createdAt: now,
        });
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          openingTransactionId: opening.id,
          openingEntryId: newId(),
          at: now,
        });

        await scope.wallets.insert(wallet);
        if (openingEntry) {
          opening.markProcessed(undefined, wallet.balance, now);
          await scope.transactions.insert(opening);
          await scope.ledger.insert(openingEntry);
          await scope.outbox.enqueue(
            settlementEvents(opening, wallet, openingEntry, command.context, {
              announcePending: false,
              now,
            }),
          );
        }

        this.logger.log({ msg: 'wallet opened', walletId: wallet.id });
        return toWalletView(wallet);
      });
    } catch (error) {
      if (
        error instanceof ConcurrentWriteError &&
        error.constraint === 'uq_wallets_player_currency'
      ) {
        throw new WalletAlreadyExistsError(
          command.playerId,
          initialBalance.currency,
        );
      }
      throw error;
    }
  }
}
