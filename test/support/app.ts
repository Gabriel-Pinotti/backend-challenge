import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG, type AppConfig, loadConfig } from '../../src/config.js';
import { prepareDatabase } from './database.js';
import { testQueues } from './sqs.js';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  config: AppConfig;
  close(): Promise<void>;
}

export async function startApp(
  configure: (config: AppConfig) => void = () => {},
  overrides: { provide: symbol; useValue: unknown }[] = [],
): Promise<TestApp> {
  await Promise.all([prepareDatabase(), testQueues()]);
  const config = loadConfig();
  configure(config);
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config);
  for (const override of overrides) {
    builder = builder
      .overrideProvider(override.provide)
      .useValue(override.useValue);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.enableShutdownHooks();
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    close: () => app.close(),
  };
}
