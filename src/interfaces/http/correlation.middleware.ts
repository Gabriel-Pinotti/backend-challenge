import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newId } from '../../domain/ids.js';
import { RequestContext } from '../../infrastructure/observability/request-context.js';

const HEADER = 'x-correlation-id';
const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const incoming = request.header(HEADER);
    const correlationId =
      incoming && VALID_ID.test(incoming) ? incoming : newId();
    response.setHeader(HEADER, correlationId);
    RequestContext.run({ correlationId }, next);
  }
}
