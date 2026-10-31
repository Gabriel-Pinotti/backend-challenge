const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

Object.assign(process.env, {
  NODE_ENV: 'test',
  POSTGRES_DB: process.env.TEST_POSTGRES_DB ?? 'wallet_test',
  WAGER_QUEUE_NAME: `test-${runId}-wagers.fifo`,
  WAGER_DLQ_NAME: `test-${runId}-wagers-dlq.fifo`,
  EVENTS_QUEUE_NAME: `test-${runId}-events.fifo`,
  SQS_CONSUMER_ENABLED: 'false',
  OUTBOX_PUBLISHER_ENABLED: 'false',
  PENDING_REFERENCE_WORKER_ENABLED: 'false',
  SQS_WAIT_TIME_SECONDS: '1',
  SQS_MAX_BACKOFF_SECONDS: '1',
  SQS_UNAVAILABLE_BACKOFF_MS: '50',
  OUTBOX_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
  PENDING_REFERENCE_BASE_DELAY_MS: '100',
  PENDING_REFERENCE_MAX_DELAY_MS: '400',
  PENDING_REFERENCE_MAX_ATTEMPTS: '3',
  SHUTDOWN_TIMEOUT_MS: '5000',
});
