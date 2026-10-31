export interface AppConfig {
  port: number;
  database: {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
    poolMax: number;
    lockTimeoutMs: number;
  };
  sqs: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
  };
  consumer: {
    enabled: boolean;
    waitTimeSeconds: number;
    maxBackoffSeconds: number;
    unavailableBackoffMs: number;
    shutdownTimeoutMs: number;
  };
  outbox: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
  };
  pendingReferences: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  faultInjection: {
    exitAfterCommitBeforeAck: boolean;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  return raw === 'true' || raw === '1';
}

function str(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    port: int(env, 'PORT', 3000),
    database: {
      host: str(env, 'DB_HOST', 'localhost'),
      port: int(env, 'DB_PORT', 5432),
      user: str(env, 'POSTGRES_USER', 'wallet'),
      password: str(env, 'POSTGRES_PASSWORD', 'wallet'),
      name: str(env, 'POSTGRES_DB', 'wallet'),
      poolMax: int(env, 'DB_POOL_MAX', 20),
      lockTimeoutMs: int(env, 'DB_LOCK_TIMEOUT_MS', 5_000),
    },
    sqs: {
      endpoint: str(env, 'SQS_ENDPOINT', 'http://localhost:4566'),
      region: str(env, 'AWS_REGION', 'us-east-1'),
      accessKeyId: str(env, 'AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: str(env, 'AWS_SECRET_ACCESS_KEY', 'test'),
      wagerQueueName: str(env, 'WAGER_QUEUE_NAME', 'wager-transactions.fifo'),
      wagerDlqName: str(env, 'WAGER_DLQ_NAME', 'wager-transactions-dlq.fifo'),
      eventsQueueName: str(env, 'EVENTS_QUEUE_NAME', 'wallet-events.fifo'),
    },
    consumer: {
      enabled: bool(env, 'SQS_CONSUMER_ENABLED', true),
      waitTimeSeconds: int(env, 'SQS_WAIT_TIME_SECONDS', 20),
      maxBackoffSeconds: int(env, 'SQS_MAX_BACKOFF_SECONDS', 300),
      unavailableBackoffMs: int(env, 'SQS_UNAVAILABLE_BACKOFF_MS', 1_000),
      shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_MS', 25_000),
    },
    outbox: {
      enabled: bool(env, 'OUTBOX_PUBLISHER_ENABLED', true),
      pollIntervalMs: int(env, 'OUTBOX_POLL_INTERVAL_MS', 1_000),
      batchSize: int(env, 'OUTBOX_BATCH_SIZE', 50),
    },
    pendingReferences: {
      enabled: bool(env, 'PENDING_REFERENCE_WORKER_ENABLED', true),
      pollIntervalMs: int(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000),
      batchSize: int(env, 'PENDING_REFERENCE_BATCH_SIZE', 50),
      maxAttempts: int(env, 'PENDING_REFERENCE_MAX_ATTEMPTS', 10),
      baseDelayMs: int(env, 'PENDING_REFERENCE_BASE_DELAY_MS', 1_000),
      maxDelayMs: int(env, 'PENDING_REFERENCE_MAX_DELAY_MS', 300_000),
    },
    faultInjection: {
      exitAfterCommitBeforeAck:
        env.NODE_ENV === 'test' &&
        bool(env, 'FAULT_EXIT_AFTER_COMMIT_BEFORE_ACK', false),
    },
  };
}
