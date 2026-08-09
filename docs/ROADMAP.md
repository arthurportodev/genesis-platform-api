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

### Concluído e incorporado

- ✅ `0.8-MVP-01` — Runtime health.
  - implementação concluída no commit
    `c2e39cee2ea05f6e0a23edd150268024b2ebe94c`;
  - incorporada à `main` pelo PR #29 no squash
    `5e76b4fde61badce3a39792f7ba9e3ee6ea806ce`.
- ✅ `0.8-MVP-02` — Rebaseline documental de produção.
  - concluída e incorporada à `main` pelo PR #29.
- ✅ `0.8-MVP-02.1` — Reconciliação do contrato documental da CI.
  - concluída no commit `f94eab1a4f02b520f176ed99b5898b25d2be8d97` e
    incorporada pelo mesmo squash;
  - CI pós-merge `30892867828` aprovada integralmente.
- ✅ `0.8-MVP-03` — Container e Compose de produção.
  - incorporada pelo PR #31 no squash
    `a568745025091bd3d309052ebd780374da405e3c`;
  - CI pós-merge `31000957615` aprovada;
  - target `production` não-root e stack privada com migration one-shot,
    hardening, health, persistência, limites e logs rotacionados.

### Concluído e incorporado — continuidade

- ✅ `0.8-MVP-04` — CI essencial, GHCR e imagem identificável.
  - incorporada pelo PR #32 no squash
    `c02af719c72277f49348de33762ff12dc589434d`;
  - a execução pós-merge `31023264462` publicou a imagem após runtime e scan
    Critical aprovados, mas falhou na evidência final por tentar obter o config
    digest de um descriptor;
  - Arthur aprovou manter público o package já exposto. Ele permanece vinculado
    ao repositório, sob tag SHA completa e sem tags `latest` ou `main`; nenhum
    deploy foi realizado;
  - `0.8-MVP-04-CORR-01` foi incorporada pelo PR #33 no squash
    `c6fbc0b865540abd9d13f93c7cc7542eb0936355`; a CI pós-merge `31249557339`
    aprovou identidade, package, rescan e artifact e concluiu integralmente a
    tarefa.
- ✅ `0.8-MVP-04-CORR-02` — publicação GHCR condicionada ao impacto real.
  - mantém validação completa em todo push da `main`;
  - usa detector read-only e fail-closed para autorizar o publicador somente
    quando Dockerfile, entradas do build ou `src/**` podem mudar a imagem;
  - deltas apenas documentais, operacionais, de Compose, CI, scripts ou testes
    não autenticam, constroem ou publicam imagem;
  - incorporada pelo PR #34; push da `main` não impactante preservou a
    validação e pulou intencionalmente a publicação;
  - nenhuma alteração no package histórico.

### Tarefa atual

- 🚧 `0.8-MVP-05A` — contrato versionado de PostgreSQL, secrets e bundle de
  produção.
  - candidata local separa bootstrap, migration owner e runtime;
  - usa secrets file-backed, digests imutáveis, volume externo e bundle mínimo;
  - não instala, transfere ou implanta qualquer artefato; Gate 2 pendente.
  - `0.8-MVP-05A-CORR-01` corrige localmente a matriz sintética da CI no PR #35;
    a Gate 2 renovada permanece pendente e nenhuma mutação remota foi autorizada.

### Próximos deltas planejados

- ⬜ `0.8-MVP-05B` — instalação controlada de Docker, layout, secrets, volume,
  PostgreSQL, migrations e API na VPS; condicionada à incorporação da 05A e a
  autorização operacional própria.
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
