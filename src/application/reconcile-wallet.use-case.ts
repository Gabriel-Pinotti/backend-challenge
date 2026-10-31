import { Inject, Injectable, Logger } from '@nestjs/common';
import { Money } from '../domain/money.js';
import { NotFoundError } from './errors.js';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
  WAGER_METRICS,
  type WagerMetrics,
} from './ports.js';
import { type ReconciliationView, signedMoney } from './views.js';

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGER_METRICS) private readonly metrics: WagerMetrics,
  ) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    const snapshot = await this.uow.transactional((scope) =>
      scope.ledger.reconciliationSnapshot(walletId),
    );
    if (!snapshot) {
      throw new NotFoundError(`wallet ${walletId} not found`);
    }
    const stored = Money.from({
      amount: snapshot.balance,
      currency: snapshot.currency,
    });
    const calculated = signedMoney(snapshot.netAmount, snapshot.currency);
    const difference = stored.subtract(calculated);
    const view: ReconciliationView = {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: snapshot.entries,
    };

    if (!view.consistent) {
      this.metrics.reconciliationMismatch();
      this.logger.error({
        msg: 'wallet balance diverges from ledger',
        walletId,
        checkedEntries: view.checkedEntries,
      });
    }
    return view;
  }
}
