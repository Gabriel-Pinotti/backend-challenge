import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { NotFoundError } from '../../application/errors.js';

export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  /** false só enquanto não há autenticação; com ela ligada, identidade ausente vira 401. */
  readonly enabled: boolean;
  resolve(request: Request): Promise<ProviderIdentity | null>;
}

export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

export type AuthenticatedRequest = Request & {
  providerIdentity?: ProviderIdentity | null;
};

export class ProviderMismatchError extends Error {
  readonly code = 'PROVIDER_MISMATCH';

  constructor() {
    super(
      'authenticated provider does not match the providerId in the request',
    );
    this.name = 'ProviderMismatchError';
  }
}

@Injectable()
export class AllowAllProviderIdentity implements ProviderIdentityPort {
  readonly enabled = false;

  async resolve(): Promise<ProviderIdentity | null> {
    return null;
  }
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = await this.identity.resolve(request);
    if (this.identity.enabled && !identity) {
      throw new UnauthorizedException();
    }
    request.providerIdentity = identity;
    return true;
  }
}

export function assertProviderMatches(
  request: AuthenticatedRequest,
  providerId: string,
): void {
  const identity = request.providerIdentity;
  if (identity && identity.providerId !== providerId) {
    throw new ProviderMismatchError();
  }
}

export function assertOwnedByProvider(
  request: AuthenticatedRequest,
  providerId: string,
  resource: string,
): void {
  const identity = request.providerIdentity;
  if (identity && identity.providerId !== providerId) {
    throw new NotFoundError(`${resource} not found`);
  }
}
