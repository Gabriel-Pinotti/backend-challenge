import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/config.js';
import { newId } from '../../src/domain/ids.js';

const config = loadConfig();

export const sqsClient = new SQSClient({
  endpoint: config.sqs.endpoint,
  region: config.sqs.region,
  credentials: {
    accessKeyId: config.sqs.accessKeyId,
    secretAccessKey: config.sqs.secretAccessKey,
  },
  useQueueUrlAsEndpoint: false,
});

export interface TestQueues {
  wagers: string;
  dlq: string;
  events: string;
}

export const TEST_VISIBILITY_TIMEOUT_SECONDS = 2;
export const TEST_MAX_RECEIVE_COUNT = 3;

let queues: Promise<TestQueues> | undefined;

async function create(
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  const output = await sqsClient.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ...attributes },
    }),
  );
  return output.QueueUrl!;
}

export function testQueues(): Promise<TestQueues> {
  queues ??= (async () => {
    const dlq = await create(config.sqs.wagerDlqName, {});
    const attributes = await sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlq,
        AttributeNames: ['QueueArn'],
      }),
    );
    const wagers = await create(config.sqs.wagerQueueName, {
      VisibilityTimeout: String(TEST_VISIBILITY_TIMEOUT_SECONDS),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: attributes.Attributes!.QueueArn,
        maxReceiveCount: String(TEST_MAX_RECEIVE_COUNT),
      }),
    });
    const events = await create(config.sqs.eventsQueueName, {});
    return { wagers, dlq, events };
  })();
  return queues;
}

export async function sendRaw(
  queueUrl: string,
  body: string,
  groupId: string,
): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: newId(),
    }),
  );
}

export async function sendWagerMessage(envelope: {
  messageId: string;
  data: { walletId: string };
}): Promise<void> {
  const { wagers } = await testQueues();
  await sendRaw(wagers, JSON.stringify(envelope), envelope.data.walletId);
}

export async function receiveAll(
  queueUrl: string,
  options: { waitSeconds?: number; deleteAfter?: boolean } = {},
): Promise<Message[]> {
  const output = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: options.waitSeconds ?? 1,
      MessageSystemAttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    }),
  );
  const messages = output.Messages ?? [];
  if (options.deleteAfter ?? true) {
    await Promise.all(
      messages.map((message) =>
        sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        ),
      ),
    );
  }
  return messages;
}

export async function queueDepth(queueUrl: string): Promise<number> {
  const output = await sqsClient.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }),
  );
  return (
    Number(output.Attributes?.ApproximateNumberOfMessages ?? 0) +
    Number(output.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
  );
}
