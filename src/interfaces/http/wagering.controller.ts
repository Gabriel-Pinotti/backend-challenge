import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SubmitWagerUseCase } from '../../application/submit-wager.use-case.js';
import type {
  SubmitWagerResult,
  TransactionView,
} from '../../application/views.js';
import { WalletQueries } from '../../application/wallet-queries.js';
import { WagerTransactionStatus } from '../../domain/wager-transaction.js';
import { RequestContext } from '../../infrastructure/observability/request-context.js';
import {
  idempotencyKeySchema,
  parseOrThrow,
  safeText,
  uuidSchema,
  wagerPayloadSchema,
} from '../schemas.js';
import { eventContext } from './event-context.js';
import {
  assertOwnedByProvider,
  assertProviderMatches,
  type AuthenticatedRequest,
  ProviderAuthGuard,
} from './provider-identity.js';

export function statusFor(result: SubmitWagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return HttpStatus.UNPROCESSABLE_ENTITY;
  }
}

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly submitWager: SubmitWagerUseCase,
    private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmitWagerResult> {
    const idempotencyKey = parseOrThrow(
      idempotencyKeySchema,
      rawKey,
      'Idempotency-Key',
    );
    const payload = parseOrThrow(wagerPayloadSchema, body);
    assertProviderMatches(request, payload.providerId);
    RequestContext.assign({
      walletId: payload.walletId,
      providerId: payload.providerId,
    });

    const result = await this.submitWager.execute({
      idempotencyKey,
      payload,
      context: eventContext(idempotencyKey),
    });

    if (result.transactionId) {
      RequestContext.assign({ transactionId: result.transactionId });
    }
    response.status(statusFor(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async get(
    @Param('transactionId') transactionId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TransactionView> {
    const view = await this.queries.getTransaction(
      parseOrThrow(uuidSchema, transactionId, 'transactionId'),
    );
    assertOwnedByProvider(
      request,
      view.providerId,
      `transaction ${transactionId}`,
    );
    return view;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TransactionView> {
    assertProviderMatches(request, providerId);
    return this.queries.getTransactionByExternalId(
      parseOrThrow(safeText, providerId, 'providerId'),
      parseOrThrow(safeText, externalTransactionId, 'externalTransactionId'),
    );
  }
}
