# Teste de carga

Resumo: no notebook de desenvolvimento, uma instância processa **cerca de 145 apostas por segundo** com p99 em torno de 0,5 s. Em todos os cenários houve **zero erros** e **todas as wallets terminaram reconciliadas**. O gargalo é a CPU do processo Bun, não o banco: nenhuma requisição estourou o `lock_timeout` de 5 s (seria uma resposta 503, e não houve nenhuma). Não existe meta de RPS no desafio; o objetivo aqui é medir com método e explicar o que limita.

## Ambiente

| Item | Valor |
| --- | --- |
| Máquina | Notebook, Intel Core i5-1345U (2 núcleos P + 8 núcleos E, 12 threads), 15 GiB de RAM |
| Sistema | Linux 7.0, Docker 29.8 |
| Banco | PostgreSQL 17 em container, configuração padrão (`synchronous_commit = on`, `shared_buffers = 128MB`) |
| SQS | MiniStack 1.5.34 em container |
| Aplicação | Bun 1.4.4, `bun src/main.ts` fora do Docker, pool de 20 conexões, todos os workers ligados (consumidor SQS, outbox, referências) |
| Gerador | `scripts/load-test.ts` na mesma máquina, disputando CPU com a aplicação e o banco |
| Data | 30/10/2026 |

## Metodologia

`bun run test:load` (código em [`scripts/load-test.ts`](../scripts/load-test.ts)):

1. cria 200 wallets com saldo alto e uma *hot wallet* com saldo 500,00;
2. monta 5.000 apostas `BET` de 1,00: uma fração vai para a hot wallet (`LOAD_HOT_WALLET_SHARE`), 10% são reenvios de requisições já montadas, com a mesma idempotency key (`LOAD_REPLAY_SHARE`), e o resto se espalha pelas 200 wallets;
3. dispara tudo com 50 requisições simultâneas (`LOAD_CONCURRENCY`), distribuídas em round-robin entre as instâncias de `BASE_URL`;
4. mede a latência de cada requisição do lado do cliente e lê `/metrics` antes e depois (conflitos de concorrência, replays) e 2 s depois do fim (`outbox_lag_seconds`);
5. chama a reconciliação de **todas** as wallets e falha se alguma divergir.

A outbox começa vazia em cada cenário. O uso de CPU foi amostrado com `ps` no meio da carga.

## Resultados

| Cenário | Vazão (req/s) | p50 | p95 | p99 | Erros | Conflitos | Outbox lag (+2 s) | Wallets divergentes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 instância, sem hot wallet | 146,6 | 331 ms | 456 ms | 534 ms | 0 | 0 | 28 s | 0 |
| 1 instância, 20% na hot wallet | 131,1 | 290 ms | 992 ms | 1.368 ms | 0 | 0 | 19 s | 0 |
| 3 instâncias, sem hot wallet | 209,2 | 234 ms | 362 ms | 501 ms | 0 | 0 | 54 s | 0 |
| 3 instâncias, 20% na hot wallet | 161,7 | 54 ms | 2.112 ms | 2.717 ms | 0 | 0 | 85 s | 0 |

Nos cenários com hot wallet, cerca de 500 respostas são `422 INSUFFICIENT_FUNDS`: a hot wallet tem saldo para 500 apostas de 1,00 e recebe cerca de 1.000. Isso é o comportamento correto, e o saldo dela termina exatamente em 0,00. Os reenvios voltaram como `200` com `idempotentReplay: true` (cerca de 470 por cenário).

### Re-medição depois da rodada final de correções (31/10/2026)

Mesmo cenário de "1 instância, sem hot wallet", depois das últimas correções e com o banco recém-recriado: **206,8 req/s**, p50 241 ms, p95 457 ms, p99 538 ms, zero erros e todas as wallets reconciliadas. A diferença para a tabela acima não foi investigada a fundo. As mudanças de código dessa rodada não mexeram no caminho quente de forma relevante, então a causa mais provável são as condições da medição: banco vazio em vez de dezenas de milhares de linhas, e outro dia na mesma máquina. A conclusão não muda: o limite é a CPU do processo.

## Análise

**A CPU do processo é o limite.** Uma requisição isolada, sem carga, leva cerca de 29 ms (p50). Com 50 simultâneas, a vazão para em cerca de 145 req/s e o processo da aplicação fica em 120–130% de CPU, ou seja, a thread de JavaScript saturada. Isso dá uns 7 ms de CPU por aposta, gastos em NestJS, MikroORM (montagem de cerca de 10 comandos SQL por aposta), validação com zod e serialização. A latência alta sob carga é tempo de fila esperando a thread, não espera por lock: nenhuma requisição chegou ao `lock_timeout` de 5 s, o que apareceria como 503. A coluna "Conflitos" é o `concurrency_conflicts_total`, que nesta medição só contava corridas de unicidade; depois dela a métrica passou a contar também lock timeouts e deadlocks.

**Três instâncias não triplicam a vazão aqui**, e o motivo é o ambiente. As três ficaram perto de 100% de CPU cada, mas dividem com o Postgres, o MiniStack e o próprio gerador um processador com só 2 núcleos de alto desempenho, enquanto os outros 8 são núcleos de eficiência. O ganho medido (+43%) não deve ser extrapolado para servidores. O ponto que o teste prova é outro: com três instâncias concorrendo nas mesmas wallets, a correção se mantém.

**Hot wallet:** as apostas na wallet disputada são serializadas pelo lock, como esperado. O p95 e o p99 sobem para 1–2,7 s porque cada requisição na fila da hot wallet segura uma conexão do pool enquanto espera. O p50 cai no cenário de três instâncias porque as requisições presas na hot wallet deixam menos requisições disputando CPU nas outras wallets. Mitigação proposta no ARCHITECTURE: limitar a concorrência por wallet antes de chegar ao banco.

**Outbox:** durante a carga, o publisher divide a CPU com as requisições e não acompanha a produção de cerca de 2 eventos por aposta, então o lag cresce durante o pico. Medimos e corrigimos duas coisas antes desta rodada: a publicação passou a usar `SendMessageBatch` (10 por chamada) e a marcação de publicado passou a ser um único `UPDATE` por lote. Numa versão anterior, com um `SendMessage` e um `UPDATE` por evento, o lag passava de 3 minutos. Mesmo assim, sob carga contínua o caminho certo é ter instâncias dedicadas à publicação.

## Como reproduzir

```bash
docker compose up -d --wait && bun run queues:create && bun run migration:up
bun run start:dev &
bun run test:load
LOAD_HOT_WALLET_SHARE=0 bun run test:load

# três instâncias locais em portas diferentes (como nas medições acima)
PORT=3001 bun src/main.ts & PORT=3002 bun src/main.ts &
BASE_URL=http://localhost:3000,http://localhost:3001,http://localhost:3002 bun run test:load

# ou três réplicas no Docker atrás do nginx em localhost:3000
docker compose --profile app up -d --build --wait --scale app=3 && bun run test:load
```

O script sai com código 1 se alguma requisição falhar com 5xx ou se alguma wallet não reconciliar.
