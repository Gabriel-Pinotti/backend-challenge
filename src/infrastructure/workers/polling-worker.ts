import {
  type BeforeApplicationShutdown,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

export interface PollingWorkerOptions {
  name: string;
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  shutdownTimeoutMs: number;
  tick: (batchSize: number) => Promise<number>;
}

export class PollingWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger: Logger;
  private running = false;
  private loop: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(private readonly options: PollingWorkerOptions) {
    this.logger = new Logger(options.name);
  }

  onApplicationBootstrap(): void {
    if (this.options.enabled) {
      this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    if (this.loop) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.logger.warn({
            msg: 'worker did not stop in time; abandoning current tick',
          });
          resolve();
        }, this.options.shutdownTimeoutMs);
      });
      await Promise.race([this.loop, timeout]);
      clearTimeout(timer);
    }
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.options.tick(this.options.batchSize);
      } catch (error) {
        this.logger.error({ msg: 'worker tick failed', error });
      }
      if (this.running && processed < this.options.batchSize) {
        await this.sleep(this.options.intervalMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = done;
    });
  }
}
