# Roadmap

Estados: ✅ Concluído · 🚧 Em andamento · ⬜ Planejado · ⏸ Adiado · ↪ Superseded

## Produto já entregue

- ✅ `0.1` — Fundação técnica do backend.
- ✅ `0.2` — Identidade, multi-tenancy, autenticação, sessões, autorização,
  convites, memberships e ownership.
- ✅ `0.3` — CRM com Leads, Pipeline, Activities, Follow-up, filas, detalhe e
  métricas.
- ✅ `0.7` — Frontend operacional com sessão, Organization ativa, Inbox,
  Pipeline, Follow-up, métricas e criação manual de Leads.

O histórico detalhado e os commits incorporados permanecem em
[TASK_LOG.md](TASK_LOG.md).

## Governança concluída

- ✅ `0.8.0` — Gate 1 técnico read-only da primeira estratégia de produção.
- ✅ `0.8.1` — Reconciliação canônica da documentação daquela estratégia.
- ✅ `0.8.1.1` — Sistema Operacional de Desenvolvimento V2, incorporado no
  backend e no frontend. Essa governança continua vigente pelo
  [ADR-012](decisions/ADR-012-development-operating-system-v2.md).

## Produção anterior ↪ Superseded

A antiga sequência `0.8.2`–`0.8.11` e seu DAG deixaram de ser o roadmap ativo.
Ela permanece apenas como histórico no
[ADR-011](decisions/ADR-011-production-architecture.md) e no
[TASK_LOG.md](TASK_LOG.md). Nenhuma implementação ou Pull Request daquele
experimento é promovido automaticamente para o MVP.

## 0.8-MVP — Primeira produção 🚧

### Concluído localmente

- ✅ `0.8-MVP-01` — Runtime health.
  - implementação concluída no commit local
    `c2e39cee2ea05f6e0a23edd150268024b2ebe94c`;
  - ainda sem push, Pull Request ou merge na `main`.

### Tarefa atual

- 🚧 `0.8-MVP-02` — Rebaseline documental de produção.

### Próximos deltas planejados

- ⬜ `0.8-MVP-03` — Container e Compose de produção.
- ⬜ `0.8-MVP-04` — CI essencial, GHCR e imagem identificável.
- ⬜ `0.8-MVP-05` — VPS, PostgreSQL, secrets e migrations.
- ⬜ `0.8-MVP-06` — Traefik, HTTPS e exposição controlada da API.
- ⬜ `0.8-MVP-07` — Backup, restore, logs, monitoramento e rollback.
- ⬜ `0.8-MVP-08` — Vercel, proxy, domínio e integração frontend/backend.
- ⬜ `0.8-MVP-09` — Smoke, isolamento cross-tenant e primeiros usuários.

Essa é uma sequência linear de planejamento e pode ser subdividida depois do
inventário, sem recriar um DAG complexo. Tarefa planejada não prova publicação,
prontidão operacional nem autorização para dados reais. A baseline vigente
está em [PRODUCTION.md](PRODUCTION.md) e no
[ADR-013](decisions/ADR-013-mvp-production-baseline.md).

## Direções futuras ⏸

Comunicação/WhatsApp, automações, tracking, analytics, relatórios e billing não
têm escopo automaticamente aprovado.
