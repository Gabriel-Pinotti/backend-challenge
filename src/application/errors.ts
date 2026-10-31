export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor(idempotencyKey: string) {
    super(
      `idempotency key ${idempotencyKey} was used with a different payload`,
    );
  }
}

export class DuplicateExternalTransactionError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_ID_REUSED';

  constructor(providerId: string, externalTransactionId: string) {
    super(
      `transaction ${externalTransactionId} from ${providerId} already exists under another idempotency key`,
    );
  }
}

export class InboxConflictError extends ApplicationError {
  readonly code = 'MESSAGE_ID_REUSED';

  constructor(messageId: string) {
    super(`message ${messageId} was already received with a different payload`);
  }
}

export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('cursor is not valid');
  }
}

export class ConcurrentWriteError extends ApplicationError {
  readonly code = 'CONCURRENT_WRITE';

  constructor(readonly constraint: string) {
    super(`concurrent write detected on ${constraint}`);
  }
}

export class DataIntegrityError extends ApplicationError {
  readonly code = 'DATA_INTEGRITY_VIOLATION';

  constructor(readonly sqlState: string) {
    super(`the database refused the write (${sqlState})`);
  }
}

export class TransientError extends ApplicationError {
  readonly code = 'TRANSIENT_ERROR';

  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}
