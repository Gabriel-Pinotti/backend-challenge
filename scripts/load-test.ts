const BASE_URLS = (process.env.BASE_URL ?? 'http://localhost:3000').split(',');
const BASE_URL = BASE_URLS[0]!;
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 5_000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);
const HOT_SHARE = Number(process.env.LOAD_HOT_WALLET_SHARE ?? 0.2);
const REPLAY_SHARE = Number(process.env.LOAD_REPLAY_SHARE ?? 0.1);

const GAUGES = new Set(['outbox_lag_seconds', 'sqs_dlq_messages']);

interface Wallet {
  id: string;
  playerId: string;
}

interface Sample {
  status: number;
  ms: number;
}

async function json(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function createWallet(amount: string): Promise<Wallet> {
  const playerId = crypto.randomUUID();
  const { status, body } = await json('/wallets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount, currency: 'BRL' },
    }),
  });
  if (status !== 201) {
    throw new Error(`wallet creation failed with ${status}`);
  }
  return { id: body.id, playerId };
}

async function scrape(): Promise<Map<string, number>> {
  const texts = await Promise.all(
    BASE_URLS.map((url) => fetch(`${url}/metrics`).then((r) => r.text())),
  );
  const values = new Map<string, number>();
  for (const line of texts.join('\n').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [series, value] = line.split(' ');
    if (series && value) {
      const name = series.replace(/\{.*\}/, '');
      const previous = values.get(name) ?? 0;
      values.set(
        name,
        GAUGES.has(name)
          ? Math.max(previous, Number(value))
          : previous + Number(value),
      );
    }
  }
  return values;
}

function percentile(sorted: number[], p: number): number {
  return (
    sorted[
      Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    ] ?? 0
  );
}

function bet(wallet: Wallet, amount: string) {
  const externalTransactionId = `load-${crypto.randomUUID()}`;
  return {
    key: `load:${externalTransactionId}`,
    body: JSON.stringify({
      providerId: 'load',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'load-round',
      gameId: 'load-game',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    }),
  };
}

const wallets = await Promise.all(
  Array.from({ length: WALLETS }, () => createWallet('1000000.00')),
);
const hot = await createWallet('500.00');

const requests: { key: string; body: string }[] = [];
for (let i = 0; i < REQUESTS; i++) {
  const roll = Math.random();
  if (roll < REPLAY_SHARE && requests.length > 0) {
    requests.push(requests[Math.floor(Math.random() * requests.length)]!);
  } else if (roll < REPLAY_SHARE + HOT_SHARE) {
    requests.push(bet(hot, '1.00'));
  } else {
    requests.push(bet(wallets[i % wallets.length]!, '1.00'));
  }
}

const before = await scrape();
const samples: Sample[] = [];
let cursor = 0;
const startedAt = performance.now();

await Promise.all(
  Array.from({ length: CONCURRENCY }, async (_, worker) => {
    const target = BASE_URLS[worker % BASE_URLS.length]!;
    while (cursor < requests.length) {
      const request = requests[cursor++]!;
      const t0 = performance.now();
      let status = 0;
      try {
        const response = await fetch(`${target}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': request.key,
          },
          body: request.body,
        });
        await response.arrayBuffer();
        status = response.status;
      } catch {
        status = 0;
      }
      samples.push({ status, ms: performance.now() - t0 });
    }
  }),
);

const elapsedSeconds = (performance.now() - startedAt) / 1000;
await new Promise((resolve) => setTimeout(resolve, 2_000));
const after = await scrape();
const delta = (name: string) =>
  (after.get(name) ?? 0) - (before.get(name) ?? 0);

const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
const byStatus = new Map<number, number>();
for (const sample of samples) {
  byStatus.set(sample.status, (byStatus.get(sample.status) ?? 0) + 1);
}
const errors = samples.filter((s) => s.status === 0 || s.status >= 500).length;

let unreconciled = 0;
for (const wallet of [...wallets, hot]) {
  const { body } = await json(`/wallets/${wallet.id}/reconciliation`, {
    method: 'POST',
  });
  if (!body.consistent) unreconciled++;
}

const report = {
  instances: BASE_URLS.length,
  requests: samples.length,
  concurrency: CONCURRENCY,
  wallets: WALLETS + 1,
  hotWalletShare: HOT_SHARE,
  replayShare: REPLAY_SHARE,
  durationSeconds: Number(elapsedSeconds.toFixed(2)),
  throughputRps: Number((samples.length / elapsedSeconds).toFixed(1)),
  latencyMs: {
    p50: Number(percentile(latencies, 50).toFixed(1)),
    p95: Number(percentile(latencies, 95).toFixed(1)),
    p99: Number(percentile(latencies, 99).toFixed(1)),
    max: Number((latencies.at(-1) ?? 0).toFixed(1)),
  },
  statuses: Object.fromEntries(
    [...byStatus.entries()].sort(([a], [b]) => a - b),
  ),
  errorRate: Number((errors / samples.length).toFixed(4)),
  concurrencyConflicts: delta('concurrency_conflicts_total'),
  idempotentReplays: delta('idempotent_replays_total'),
  outboxLagSecondsAfter2s: after.get('outbox_lag_seconds') ?? null,
  unreconciledWallets: unreconciled,
};

console.log(JSON.stringify(report, null, 2));
if (unreconciled > 0 || errors > 0) {
  process.exitCode = 1;
}
