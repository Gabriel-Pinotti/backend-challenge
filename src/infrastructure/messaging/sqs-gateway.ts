import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { EventPublisher } from '../../application/ports.js';
import type { OutboxMessage } from '../../domain/outbox-message.js';
import { APP_CONFIG, type AppConfig } from '../../config.js';

const SQS_BATCH_LIMIT = 10;

@Injectable()
export class SqsGateway implements EventPublisher, OnApplicationShutdown {
  readonly client: SQSClient;
  private readonly urls = new Map<string, Promise<string>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = new SQSClient({
      endpoint: config.sqs.endpoint,
      region: config.sqs.region,
      credentials: {
        accessKeyId: config.sqs.accessKeyId,
        secretAccessKey: config.sqs.secretAccessKey,
      },
      useQueueUrlAsEndpoint: false,
      requestHandler: {
        connectionTimeout: 3_000,
        requestTimeout: (config.consumer.waitTimeSeconds + 10) * 1_000,
      },
    });
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }

  queueUrl(name: string): Promise<string> {
    let url = this.urls.get(name);
    if (!url) {
      url = this.client
        .send(new GetQueueUrlCommand({ QueueName: name }))
        .then((output) => {
          if (!output.QueueUrl) {
            throw new Error(`queue ${name} has no url`);
          }
          return output.QueueUrl;
        });
      url.catch(() => this.urls.delete(name));
      this.urls.set(name, url);
    }
    return url;
  }

  async publish(messages: OutboxMessage[]): Promise<Set<string>> {
    const failed = new Set<string>();
    const queueUrl = await this.queueUrl(this.config.sqs.eventsQueueName);
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
      try {
        const output = await this.client.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((message) => ({
              Id: message.id,
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
              MessageAttributes: {
                eventType: {
                  DataType: 'String',
                  StringValue: message.eventType,
                },
              },
            })),
          }),
        );
        for (const failure of output.Failed ?? []) {
          if (failure.Id) {
            failed.add(failure.Id);
          }
        }
      } catch {
        for (const message of chunk) {
          failed.add(message.id);
        }
      }
    }
    return failed;
  }

  async receiveWagers(
    waitTimeSeconds: number,
    signal: AbortSignal,
  ): Promise<Message[]> {
    const output = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(this.config.sqs.wagerQueueName),
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitTimeSeconds,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
      }),
      { abortSignal: signal },
    );
    return output.Messages ?? [];
  }

  async deleteWager(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queueUrl(this.config.sqs.wagerQueueName),
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async changeWagerVisibility(
    receiptHandle: string,
    seconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(this.config.sqs.wagerQueueName),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async sendToWagerDlq(message: Message, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(this.config.sqs.wagerDlqName),
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          deadLetterReason: { DataType: 'String', StringValue: reason },
        },
      }),
    );
  }

  async wagerDlqDepth(): Promise<number> {
    const output = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.queueUrl(this.config.sqs.wagerDlqName),
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    return Number(output.Attributes?.ApproximateNumberOfMessages ?? 0);
  }

  async ping(): Promise<void> {
    await this.client.send(
      new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerQueueName }),
    );
  }
}
