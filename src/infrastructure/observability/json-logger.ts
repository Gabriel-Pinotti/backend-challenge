import type { LoggerService, LogLevel } from '@nestjs/common';
import { RequestContext } from './request-context.js';

const CONTEXT_FIELDS = [
  'correlationId',
  'messageId',
  'transactionId',
  'walletId',
  'providerId',
] as const;

const SQL_STATE = /^[0-9A-Z]{5}$/;

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && SQL_STATE.test(code)) {
    return { name: error.name, code, message: error.message.split('\n')[0] };
  }
  return { name: error.name, message: error.message, stack: error.stack };
}

export class JsonLogger implements LoggerService {
  constructor(
    private readonly write: (line: string) => void = (line) =>
      process.stdout.write(`${line}\n`),
  ) {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('verbose', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }

  private emit(
    level: LogLevel | 'info',
    message: unknown,
    params: unknown[],
  ): void {
    const context =
      typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      ...(context && { context }),
    };
    const request = RequestContext.get();
    for (const field of CONTEXT_FIELDS) {
      if (request[field] !== undefined) {
        record[field] = request[field];
      }
    }
    if (
      typeof message === 'object' &&
      message !== null &&
      !(message instanceof Error)
    ) {
      for (const [key, value] of Object.entries(message)) {
        if (value !== undefined) {
          record[key] = key === 'error' ? serializeError(value) : value;
        }
      }
    } else if (message instanceof Error) {
      record.msg = message.message;
      record.error = serializeError(message);
    } else {
      record.msg = String(message);
    }
    if (
      level === 'error' &&
      typeof params[0] === 'string' &&
      params.length > 1
    ) {
      record.stack = params[0];
    }
    this.write(JSON.stringify(record));
  }
}
