import { Controller, Get, Header, Logger } from '@nestjs/common';
import { PublishOutboxUseCase } from '../../application/publish-outbox.use-case.js';
import { SqsGateway } from '../../infrastructure/messaging/sqs-gateway.js';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics.js';

@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(
    private readonly metrics: PrometheusMetrics,
    private readonly publishOutbox: PublishOutboxUseCase,
    private readonly sqs: SqsGateway,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(): Promise<string> {
    const [lag, dlq] = await Promise.allSettled([
      this.publishOutbox.oldestPendingAgeSeconds(),
      this.sqs.wagerDlqDepth(),
    ]);
    if (lag.status === 'fulfilled') {
      this.metrics.outboxLag.set(lag.value);
    }
    if (dlq.status === 'fulfilled') {
      this.metrics.sqsDlqDepth.set(dlq.value);
    }
    if (lag.status === 'rejected' || dlq.status === 'rejected') {
      this.logger.warn({ msg: 'some gauges could not be refreshed' });
    }
    return this.metrics.registry.metrics();
  }
}
