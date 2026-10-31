import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../../application/reconcile-wallet.use-case.js';
import type {
  LedgerPageView,
  ReconciliationView,
  WalletView,
} from '../../application/views.js';
import { WalletQueries } from '../../application/wallet-queries.js';
import { RequestContext } from '../../infrastructure/observability/request-context.js';
import {
  createWalletSchema,
  ledgerQuerySchema,
  parseOrThrow,
  uuidSchema,
} from '../schemas.js';
import { eventContext } from './event-context.js';
import { ProviderAuthGuard } from './provider-identity.js';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
    private readonly queries: WalletQueries,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: unknown): Promise<WalletView> {
    const input = parseOrThrow(createWalletSchema, body);
    return this.createWallet.execute({ ...input, context: eventContext() });
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.getWallet(this.walletId(walletId));
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query() query: unknown,
  ): Promise<LedgerPageView> {
    const { cursor, limit } = parseOrThrow(ledgerQuerySchema, query);
    return this.queries.getLedger(this.walletId(walletId), cursor, limit);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('walletId') walletId: string): Promise<ReconciliationView> {
    return this.reconcileWallet.execute(this.walletId(walletId));
  }

  private walletId(raw: string): string {
    const walletId = parseOrThrow(uuidSchema, raw, 'walletId');
    RequestContext.assign({ walletId });
    return walletId;
  }
}
