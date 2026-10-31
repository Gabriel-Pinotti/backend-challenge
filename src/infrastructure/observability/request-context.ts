import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContextFields>();

export const RequestContext = {
  run<T>(fields: RequestContextFields, fn: () => T): T {
    return storage.run({ ...fields }, fn);
  },

  get(): RequestContextFields {
    return storage.getStore() ?? {};
  },

  assign(fields: RequestContextFields): void {
    const store = storage.getStore();
    if (store) {
      Object.assign(store, fields);
    }
  },
};
