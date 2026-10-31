import { EntityManager } from '@mikro-orm/postgresql';
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SqsGateway } from '../../infrastructure/messaging/sqs-gateway.js';

type CheckStatus = 'up' | 'down';

async function check(probe: () => Promise<unknown>): Promise<CheckStatus> {
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2_000),
      ),
    ]);
    return 'up';
  } catch {
    return 'down';
  }
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsGateway,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const [postgres, sqs] = await Promise.all([
      check(() => this.em.fork().execute('select 1')),
      check(() => this.sqs.ping()),
    ]);
    const ready = postgres === 'up' && sqs === 'up';
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }
}
