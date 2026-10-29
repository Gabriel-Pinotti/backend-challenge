#!/usr/bin/env bash
set -euo pipefail

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1

SQS_ENDPOINT="${SQS_ENDPOINT:-http://localhost:4566}"
MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-5}"

MAIN_QUEUE=wager-transactions.fifo
DLQ=wager-transactions-dlq.fifo

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

attributes=$(printf '{"FifoQueue":"true","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"%s\\"}"}' \
  "$dlq_arn" "$MAX_RECEIVE_COUNT")

main_url=$(sqs create-queue \
  --queue-name "$MAIN_QUEUE" \
  --attributes "$attributes" \
  --query QueueUrl --output text)

echo "DLQ:   $dlq_url"
echo "Fila:  $main_url (maxReceiveCount=$MAX_RECEIVE_COUNT)"
