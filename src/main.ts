import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { JsonLogger } from './infrastructure/observability/json-logger.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new JsonLogger(),
  });
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  await app.listen(loadConfig().port);
}
await bootstrap();
