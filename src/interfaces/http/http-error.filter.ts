import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ConcurrentWriteError,
  DuplicateExternalTransactionError,
  IdempotencyConflictError,
  InboxConflictError,
  InvalidCursorError,
  NotFoundError,
  TransientError,
  WalletAlreadyExistsError,
} from '../../application/errors.js';
import {
  DomainError,
  InvalidMoneyError,
  InvalidWagerTransactionError,
} from '../../domain/errors.js';
import { RequestValidationError } from '../schemas.js';
import { ProviderMismatchError } from './provider-identity.js';

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

interface MappedError {
  status: number;
  body: ErrorBody;
  retryAfterSeconds?: number;
}

const CONFLICTS = [
  IdempotencyConflictError,
  DuplicateExternalTransactionError,
  WalletAlreadyExistsError,
  InboxConflictError,
];

const HTTP_EXCEPTION_CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'PAYLOAD_TOO_LARGE',
};

export function mapError(error: unknown): MappedError {
  if (error instanceof RequestValidationError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: {
        code: error.code,
        message: 'request is invalid',
        details: error.issues,
      },
    };
  }
  if (
    error instanceof InvalidCursorError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerTransactionError
  ) {
    return {
      status: HttpStatus.BAD_REQUEST,
      body: { code: 'VALIDATION_ERROR', message: error.message },
    };
  }
  if (error instanceof NotFoundError) {
    return {
      status: HttpStatus.NOT_FOUND,
      body: { code: error.code, message: error.message },
    };
  }
  if (error instanceof ProviderMismatchError) {
    return {
      status: HttpStatus.FORBIDDEN,
      body: { code: error.code, message: error.message },
    };
  }
  if (CONFLICTS.some((type) => error instanceof type)) {
    const conflict = error as InstanceType<(typeof CONFLICTS)[number]>;
    return {
      status: HttpStatus.CONFLICT,
      body: { code: conflict.code, message: conflict.message },
    };
  }
  if (
    error instanceof TransientError ||
    error instanceof ConcurrentWriteError
  ) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: {
        code: 'TRANSIENT_ERROR',
        message: 'temporarily unavailable, retry with the same Idempotency-Key',
      },
      retryAfterSeconds: 1,
    };
  }
  if (error instanceof DomainError) {
    return {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      body: { code: error.code, message: error.message },
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      status,
      body: {
        code:
          HTTP_EXCEPTION_CODES[status] ??
          (status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR'),
        message: status < 500 ? error.message : 'unexpected error',
      },
    };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: 'INTERNAL_ERROR', message: 'unexpected error' },
  };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = mapError(exception);
    if (mapped.status >= 500) {
      this.logger.error({
        msg: 'request failed',
        status: mapped.status,
        error: exception,
      });
    }
    if (mapped.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    response.status(mapped.status).json(mapped.body);
  }
}
