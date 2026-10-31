import { z } from 'zod';
import { InvalidMoneyError } from '../domain/errors.js';
import { Money } from '../domain/money.js';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransactionKind,
} from '../domain/wager-transaction.js';

export class RequestValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';

  constructor(readonly issues: { path: string; message: string }[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'RequestValidationError';
  }
}

export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  input: unknown,
  pathPrefix = '',
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        path:
          [pathPrefix, ...issue.path.map(String)].filter(Boolean).join('.') ||
          '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}

function isSafeText(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    if (isLowSurrogate) {
      return false;
    }
    if (isHighSurrogate) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      i += 1;
    }
  }
  return true;
}

export const safeText = z.string().min(1).max(200).refine(isSafeText, {
  message: 'must not contain control characters or unpaired surrogates',
});

const externalId = safeText;

export const moneySchema = z
  .object({ amount: z.string(), currency: z.string() })
  .superRefine((value, ctx) => {
    try {
      Money.from(value);
    } catch (error) {
      if (!(error instanceof InvalidMoneyError)) {
        throw error;
      }
      ctx.addIssue({ code: 'custom', message: error.message });
    }
  });

export const idempotencyKeySchema = z
  .string({ error: 'Idempotency-Key header is required' })
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'must contain only visible ASCII characters');

export const uuidSchema = z.uuid().transform((id) => id.toLowerCase());

export const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export const wagerPayloadSchema = z
  .object({
    providerId: externalId.refine((id) => id !== INTERNAL_PROVIDER_ID, {
      message: `${INTERNAL_PROVIDER_ID} is reserved`,
    }),
    externalTransactionId: externalId,
    playerId: uuidSchema,
    walletId: uuidSchema,
    roundId: externalId,
    gameId: externalId,
    kind: z.enum(SUBMITTABLE_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: externalId.optional(),
  })
  .superRefine((value, ctx) => {
    const isReversal =
      value.kind === WagerTransactionKind.Refund ||
      value.kind === WagerTransactionKind.Rollback;
    if (isReversal && value.referenceExternalTransactionId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: `required for ${value.kind}`,
      });
    }
    if (
      value.kind === WagerTransactionKind.Bet &&
      value.referenceExternalTransactionId !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: 'BET cannot reference another transaction',
      });
    }
  });

export const createWalletSchema = z.object({
  playerId: uuidSchema,
  initialBalance: moneySchema,
});

export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const wagerMessageSchema = z.object({
  messageId: safeText,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  correlationId: safeText.optional(),
  data: z.intersection(
    wagerPayloadSchema,
    z.object({ idempotencyKey: idempotencyKeySchema }),
  ),
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;
