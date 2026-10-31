import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { waitFor } from './api.js';
import { prepareDatabase } from './database.js';
import { testQueues } from './sqs.js';

export interface AppProcess {
  baseUrl: string;
  logFile: string;
  process: Subprocess;
  stop(signal?: NodeJS.Signals): Promise<number>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export async function spawnApp(
  env: Record<string, string> = {},
  options: { waitUntilReady?: boolean } = {},
): Promise<AppProcess> {
  await Promise.all([prepareDatabase(), testQueues()]);
  const port = await freePort();
  const logFile = join(tmpdir(), `wallet-service-${port}-${Date.now()}.log`);
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: join(import.meta.dir, '..', '..'),
    env: { ...process.env, PORT: String(port), DB_POOL_MAX: '10', ...env },
    stdout: Bun.file(logFile),
    stderr: Bun.file(`${logFile}.err`),
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  if (options.waitUntilReady ?? true) {
    await waitFor(
      () =>
        fetch(`${baseUrl}/health/live`)
          .then((response) => response.status)
          .catch(() => 0),
      (status) => status === 200 || child.exitCode !== null,
      20_000,
      100,
    );
    if (child.exitCode !== null) {
      throw new Error(
        `app exited during startup (code ${child.exitCode}); see ${logFile}.err`,
      );
    }
  }
  return {
    baseUrl,
    logFile,
    process: child,
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode === null) {
        child.kill(signal);
      }
      return child.exited;
    },
  };
}
