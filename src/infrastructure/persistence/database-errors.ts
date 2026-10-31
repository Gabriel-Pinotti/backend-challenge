import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';
import {
  ConcurrentWriteError,
  DataIntegrityError,
  TransientError,
} from '../../application/errors.js';

const TRANSIENT_SQL_STATES = new Set([
  '40001',
  '40P01',
  '55P03',
  '57014',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08000',
  '08003',
  '08006',
]);

export const LOCK_CONFLICT_REASONS = new Set(['40001', '40P01', '55P03']);

const PERMANENT_SQL_STATE = /^(22|23|P0)/;

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

const CONNECTION_FAILURE =
  /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect|Client has encountered a connection error/i;

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const candidate = error as { code?: unknown; sqlState?: unknown };
  if (typeof candidate.code === 'string') {
    return candidate.code;
  }
  return typeof candidate.sqlState === 'string'
    ? candidate.sqlState
    : undefined;
}

export function constraintOf(error: Error): string {
  const fromDriver = (error as { constraint?: unknown }).constraint;
  if (typeof fromDriver === 'string') {
    return fromDriver;
  }
  return /constraint "([^"]+)"/.exec(error.message)?.[1] ?? 'unknown';
}

export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof UniqueConstraintViolationException) {
    return new ConcurrentWriteError(constraintOf(error));
  }
  if (error instanceof DeadlockException) {
    return transient(codeOf(error) ?? '40P01');
  }
  if (error instanceof LockWaitTimeoutException) {
    return transient(codeOf(error) ?? '55P03');
  }
  if (error instanceof ConnectionException) {
    return transient('connection');
  }
  const code = codeOf(error);
  if (
    code &&
    (TRANSIENT_SQL_STATES.has(code) || TRANSIENT_NETWORK_CODES.has(code))
  ) {
    return transient(code);
  }
  if (error instanceof Error && CONNECTION_FAILURE.test(error.message)) {
    return transient('connection');
  }
  if (code && PERMANENT_SQL_STATE.test(code)) {
    return new DataIntegrityError(code);
  }
  return error;
}

function transient(reason: string): TransientError {
  return new TransientError(
    `database temporarily unavailable (${reason})`,
    reason,
  );
}
