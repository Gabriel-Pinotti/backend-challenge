# Wallet service — Distributed Wagering Processor

Serviço financeiro que processa apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores de jogos, por HTTP e por SQS. Ele continua correto com mensagens duplicadas, fora de ordem, concorrentes e com várias instâncias rodando ao mesmo tempo.

- Enunciado do desafio: [docs/CHALLENGE.md](docs/CHALLENGE.md)
- Decisões técnicas, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)
- Teste de carga (metodologia e resultados): [docs/LOAD_TEST.md](docs/LOAD_TEST.md)

Stack: Bun 1.4, TypeScript estrito, NestJS 12, MikroORM 7, PostgreSQL 17, SQS emulado pelo [MiniStack](https://www.ministack.org/), Docker Compose.

## Pré-requisitos

| Ferramenta | Versão | Para quê |
| --- | --- | --- |
| Docker + Compose | Compose v2 | Postgres, MiniStack e (opcional) a aplicação |
| Bun | 1.4 ou mais novo | Rodar a aplicação e os testes fora do Docker |
| AWS CLI | v2 | Só para `bun run queues:create` fora do Docker |

## Rodar tudo com Docker

```bash
docker compose --profile app up -d --build --wait
```

Sobe Postgres, MiniStack, cria as filas, aplica as migrations e inicia a API, que fica em `http://localhost:3000` atrás de um nginx (`docker/nginx.conf`). Todas as portas do compose escutam só em `127.0.0.1`. Para três instâncias atrás do mesmo endereço, com o nginx distribuindo as requisições entre elas:

```bash
docker compose --profile app up -d --build --wait --scale app=3
```

Para derrubar só a aplicação e manter Postgres e MiniStack: `docker compose --profile app rm -sf gateway app migrate queues`.

## Desenvolvimento local

```bash
cp .env.example .env
docker compose up -d --wait   # só Postgres e MiniStack
bun install
bun run queues:create         # cria wager-transactions(.fifo), a DLQ e wallet-events.fifo
bun run migration:up
bun run start:dev             # http://localhost:3000, recarrega ao salvar
```

O MiniStack não guarda as filas quando o container reinicia. Depois de qualquer `docker compose up` que recrie o container `sqs`, rode `bun run queues:create` de novo.

## Testes

Todos os testes de integração e concorrência usam o Postgres e o MiniStack reais do `docker compose`; nada é mockado. Eles criam sozinhos o banco `wallet_test` (recriado do zero a cada execução; outro nome com `TEST_POSTGRES_DB`) e filas SQS com nome único por execução, então não interferem no banco de desenvolvimento.

```bash
docker compose up -d --wait
bun test                    # tudo: unidade, integração e concorrência (~50 s)
bun run test:unit           # só domínio e regras puras, sem Docker
bun run test:integration    # integração e concorrência
```

O que cada pasta cobre:

| Pasta | Conteúdo |
| --- | --- |
| `src/**/*.spec.ts` | Unidade: `Money`, `Wallet`, ledger, transições da `WagerTransaction`, regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, `payloadHash` |
| `test/integration` | Migrations reversíveis e cada constraint do schema, atomicidade, API HTTP, idempotência, outbox (publishers concorrentes, retry, outra instância assumindo), consumidor SQS (inbox, redelivery, retry, DLQ) |
| `test/concurrency` | 50 apostas idênticas em paralelo, 100 contra 80+80, hot wallet, wallets em paralelo, reversões antes da referência, 3 processos simultâneos, worker morto depois do commit e antes do ack, SIGTERM, `kill -9` no meio do tráfego |

### Teste de carga

Com a aplicação rodando (por `bun run start:dev` ou pelo Docker):

```bash
bun run test:load
BASE_URL=http://localhost:3000,http://localhost:3001,http://localhost:3002 bun run test:load
```

Parâmetros por variável de ambiente: `LOAD_REQUESTS` (5000), `LOAD_CONCURRENCY` (50), `LOAD_WALLETS` (200), `LOAD_HOT_WALLET_SHARE` (0.2) e `LOAD_REPLAY_SHARE` (0.1). Resultados e análise em [docs/LOAD_TEST.md](docs/LOAD_TEST.md).

## Comandos

| Comando | O que faz |
| --- | --- |
| `bun run start:dev` | API com recarga automática |
| `bun run start` | API sem recarga |
| `bun run migration:up` / `migration:down` | Aplica ou reverte migrations |
| `bun run migration:create <nome>` | Cria uma migration em branco para escrever o SQL à mão |
| `bun run queues:create` | Cria as filas no MiniStack (pode rodar mais de uma vez) |
| `bun test` | Todos os testes |
| `bun run typecheck` | Checagem de tipos com `tsc` |
| `bun run lint` / `bun run format` | oxlint e Prettier |

## API

| Método e rota | Descrição |
| --- | --- |
| `POST /wallets` | Cria wallet; saldo inicial positivo gera transação `OPENING` e crédito no ledger |
| `GET /wallets/:walletId` | Saldo e versão |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Extrato paginado por cursor opaco |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo guardado com o reconstruído pelo ledger |
| `POST /wagering/transactions` | Submete uma transação; header `Idempotency-Key` obrigatório |
| `GET /wagering/transactions/:transactionId` | Consulta pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta pelo id do provedor |
| `GET /health/live`, `GET /health/ready` | Liveness e readiness (Postgres e SQS) |
| `GET /metrics` | Métricas Prometheus, para o scraper interno; o nginx do compose não expõe |

Exemplo:

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Status HTTP: `201` processada agora, `200` replay, `202` aguardando referência, `400` payload inválido, `409` conflito de idempotência, `422` rejeitada por regra de negócio (com `failureCode`), `503` falha transitória com `Retry-After`. A tabela completa e a taxonomia de `failureCode` estão no [ARCHITECTURE.md](ARCHITECTURE.md#status-http-e-códigos-de-falha).

Mensagens SQS vão para `wager-transactions.fifo` no formato do enunciado (`messageId`, `type: "WagerTransactionRequested"`, `occurredAt`, `data` com `idempotencyKey`). Eventos de integração saem em `wallet-events.fifo`.

## Variáveis de ambiente

Todas têm valor padrão; o `.env.example` traz só as do banco.

| Variável | Padrão | Uso |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `DB_HOST`, `DB_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `localhost`, `5432`, `wallet`… | Conexão com o Postgres |
| `DB_POOL_MAX` | `20` | Conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `5000` | `lock_timeout` de cada transação; estourar vira 503 / retry |
| `SQS_ENDPOINT` | `http://localhost:4566` | MiniStack |
| `WAGER_QUEUE_NAME`, `WAGER_DLQ_NAME`, `EVENTS_QUEUE_NAME` | nomes do enunciado | Filas |
| `SQS_CONSUMER_ENABLED`, `OUTBOX_PUBLISHER_ENABLED`, `PENDING_REFERENCE_WORKER_ENABLED` | `true` | Liga cada worker por instância |
| `PENDING_REFERENCE_MAX_ATTEMPTS`, `PENDING_REFERENCE_BASE_DELAY_MS`, `PENDING_REFERENCE_MAX_DELAY_MS` | `10`, `1000`, `300000` | Política de retry de referência ausente |
| `SQS_WAIT_TIME_SECONDS`, `SQS_MAX_BACKOFF_SECONDS` | `20`, `300` | Long polling e backoff do consumidor |
| `SQS_UNAVAILABLE_BACKOFF_MS` | `1000` | Intervalo inicial dos testes de banco enquanto o consumidor está pausado |
| `SHUTDOWN_TIMEOUT_MS` | `25000` | Tempo máximo para terminar mensagens em andamento no SIGTERM |
