# ADR-009 — Activities, Notes e Next Action tipadas

- **Status:** Accepted
- **Data:** 2026-07-27

## Contexto

O lifecycle 0.3.2 preserva estado atual, ciclos imutáveis e retornos após fechamento. O acompanhamento comercial também precisa distinguir interações concluídas, observações manuais e o próximo compromisso sem transformar a timeline em armazenamento genérico de conteúdo sensível.

Essas operações disputam revisão, assignment, offboarding e fechamento. O estado temporal `today` depende do contexto local da empresa, enquanto os instantes precisam continuar absolutos e independentes do ambiente de execução.

## Decisão

Activities, Notes e Next Actions usam tabelas canônicas próprias, tenant-scoped e ligadas a Lead e Commercial Cycle. Activity e Note são append-only. Existe no máximo uma Next Action `pending` por Lead, com transições terminais `completed` e `canceled`; conclusão cria uma Activity tipada e vinculada exatamente uma vez.

`organizations.crm_time_zone` armazena um identificador IANA obrigatório, validado contra `pg_timezone_names`, com default e backfill `America/Belem`. `dueAt` é persistido como `timestamptz`. `overdue`, `today`, `future` e `none` são derivados somente na leitura dedicada, pelo relógio PostgreSQL e pela projeção IANA da Organization, sem integrar o ETag estável do Lead.

As seis mutações usam `If-Match`, UUID v4 de idempotência e fingerprint HMAC versionado. Assignment transfere a pendência; unassignment e offboarding limpam seu responsável; fechamento cancela com `lead_closed`; reativação não restaura. Cada comando efetivo incrementa a revisão do Lead uma vez.

A timeline pagina por sequência monotônica e guarda referências tipadas e snapshots escalares. Conteúdo livre permanece nas tabelas canônicas e só é resolvido depois da autorização do Lead. Efeitos atômicos relacionados aparecem como um único item operacional.

## Alternativas consideradas

- Tabela genérica de interações: recusada porque mistura conceitos, enfraquece constraints e incentiva payload JSON irrestrito.
- Conteúdo completo na timeline: recusado por duplicar PII e ampliar superfícies de vazamento e retenção.
- Timezone do processo, sessão ou cliente: recusado por produzir classificação não determinística entre réplicas e tenants.
- Múltiplas pendências ou substituição implícita: recusadas no MVP; mudar tipo ou descrição exige cancelamento explícito seguido de nova criação.

## Consequências

- O banco impõe append-only, state machine, uma pendência e vínculos tenant-scoped, enquanto funções estreitas preservam lock order, autorização e exactly-once.
- Owner/admin podem registrar histórico administrativo no último ciclo fechado; member permanece somente leitura em Lead fechado e perde acesso após desatribuição ou offboarding.
- A resposta temporal usa `Cache-Control: no-store` e não possui ETag; o resumo estável no Lead não contém classificação derivada.
- O rollback é seguro apenas antes de dados reais da 0.3.3; depois disso, a evolução é por forward-fix.
- Recorrência, notificações, calendário, automações, busca, métricas e habilitação do `genesis_form` permanecem fora do escopo.

## Relações

- Complementa o [ADR-002](ADR-002-multi-tenant-strategy.md).
- Complementa o [ADR-005](ADR-005-role-based-authorization.md).
- Complementa o [ADR-008](ADR-008-lead-commercial-lifecycle.md).

## Implementação

Implementado como candidato local da Tarefa 0.3.3 pela migration aditiva `1785519600000-ManageLeadActivitiesFollowUp.ts`, pelas entidades e APIs do `LeadsModule` e pelos testes unitários, PostgreSQL e E2E correspondentes.
