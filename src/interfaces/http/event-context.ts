import { newId } from '../../domain/ids.js';
import type { EventContext } from '../../domain/integration-events.js';
import { RequestContext } from '../../infrastructure/observability/request-context.js';

export function eventContext(causationId?: string): EventContext {
  return {
    correlationId: RequestContext.get().correlationId ?? newId(),
    ...(causationId !== undefined && { causationId }),
  };
}
