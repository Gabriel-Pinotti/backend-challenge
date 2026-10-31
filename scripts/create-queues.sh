#!/usr/bin/env bash
set -euo pipefail

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1

SQS_ENDPOINT="${SQS_ENDPOINT:-http://localhost:4566}"
MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-10}"

MAIN_QUEUE="${WAGER_QUEUE_NAME:-wager-transactions.fifo}"
DLQ="${WAGER_DLQ_NAME:-wager-transactions-dlq.fifo}"
EVENTS_QUEUE="${EVENTS_QUEUE_NAME:-wallet-events.fifo}"

sqs() {
  aws --endpoint-url "$SQS_ENDPOINT" sqs "$@"
}

dlq_url=$(sqs create-queue \
  --queue-name "$DLQ" \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

dlq_arn=$(sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

redrive=$(printf '{"RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"%s\\"}"}' \
  "$dlq_arn" "$MAX_RECEIVE_COUNT")

main_url=$(sqs create-queue \
  --queue-name "$MAIN_QUEUE" \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

sqs set-queue-attributes \
  --queue-url "$main_url" \
  --attributes "$redrive"

events_url=$(sqs create-queue \
  --queue-name "$EVENTS_QUEUE" \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

echo "DLQ:     $dlq_url"
echo "Fila:    $main_url (maxReceiveCount=$MAX_RECEIVE_COUNT)"
echo "Eventos: $events_url"
