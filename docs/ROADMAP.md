# Roadmap

Estados: ✅ Concluído · 🚧 Em andamento · ⬜ Planejado · ⏸ Adiado

## 0.1 — Fundação técnica ✅

- ✅ `0.1.1` — Fundação do backend.

## 0.2 — Identidade e multi-tenancy ✅

As tarefas `0.2.1`–`0.2.5.4` concluíram núcleo multi-tenant, autenticação,
sessões, CI, governança, organização ativa, autorização, convites,
memberships e ownership. O histórico detalhado permanece em
[TASK_LOG.md](TASK_LOG.md).

## 0.3 — CRM ✅

- ✅ `0.3.1` — Fundação e Inbox de Leads (PR #18, squash
  `dbaa1a0430c7b0a65ce28ca20d3eff277aa7cdca`).
- ✅ `0.3.2` — Pipeline comercial, fechamento e retorno (PR #19, squash
  `6fa39f103b9ebf65f93d26fcbc60504fa47d4e37`).
- ✅ `0.3.3` — Atividades e Follow-up (PR #20, squash
  `7c39fede23fd36e2a4c2f17da5043494f5e42ac1`).
- ✅ `0.3.4` — Experiência Operacional (PR #21, squash
  `f625745b17828a47208cc27461cc8cb6d8d9e67a`).

## 0.4–0.6 — Direções futuras

- ⬜ Comunicação e WhatsApp.
- ⬜ Automações.
- ⬜ Tracking, analytics e relatórios.

Esses itens não são compromissos de escopo sem nova decisão de produto.

## 0.7 — Frontend operacional ✅

- ✅ `0.7.0` — Contrato Web de Sessão e Bootstrap no backend (PR #22, squash
  `9f0fb751f6e506ade1d0e0af0f7f80506b4a93f2`).
- ✅ `0.7.1.1` — Bootstrap do frontend (PR #1 do frontend, squash
  `30b91272088dd9be03b8bd9feffbf74dac48acc7`).
- ✅ `0.7.1.2` — Sessão Web, Organization Ativa e HTTP (PR #2, squash
  `633ace9b55ec25e70f1f88089865f89db464ed5f`).
- ✅ `0.7.2` — Inbox e Detalhe (PR #3, squash
  `859823501bbdee03441a9fa865d823f3890be07a`).
- ✅ `0.7.3` — Pipeline Kanban (PR #4, squash
  `1040523fa4b415e1cdf25d7f61085c3765f33eb9`).
- ✅ `0.7.4` — Follow-up e Filas Operacionais (PR #5, squash
  `f9fc37dd31fa2116a66354d46938c60d566fe101`).
- ✅ `0.7.5` — Métricas Operacionais (PR #6, squash
  `1ac7e26cda535cbf3e5c02dd78da4e0fb95a2e9e`).
- ✅ `0.7.6` — Criação Manual de Leads (PR #7, squash
  `4e4f8db0fcd31a4280d72f8cba0a1e0b47f4fa92`).

## 0.8 — Infraestrutura e produção 🚧

- ✅ `0.8.0` — Arquitetura e Plano de Produção: Gate 1 read-only; decisões
  humanas aprovadas em 30 de julho de 2026.
- 🚧 `0.8.1` — Reconciliação Canônica da Documentação (`Normal / docs`, dois
  repositórios).
- ⬜ `0.8.2` — Hardening e Imagem de Produção da API (`Critical / critical`):
  Dockerfile, manifests, readiness, logs, secrets, limits e GHCR; sem deploy.
- ⬜ `0.8.3` — PostgreSQL, Roles, Migrations e Restore (`Critical / critical`):
  banco dedicado, roles separadas, migration job, backup e restore sintético;
  depende do inventário da VPS e de `0.8.2`, sem dados reais.
- ⬜ `0.8.4` — Stack da API na Hetzner: redes, volumes, uma réplica, imagem por
  digest e health interno, sem exposição pública direta.
- ⬜ `0.8.5` — Origem, Traefik, TLS e Firewall: origem protegida, forwarded
  headers e bloqueio externo de `3000` e `5432`.
- ⬜ `0.8.6` — Proxy e Segurança do Frontend: Production-only, Preview
  fail-closed, `/api/v1` fora do fallback SPA, headers, cookies e CSRF.
- ⬜ `0.8.7` — Projeto Vercel: conexão à `main`, Node.js 24, variáveis por
  ambiente e validação sem domínio final.
- ⬜ `0.8.8` — Domínio e DNS do App: `app.agenciagenesis.com.br`, TLS, cutover
  e rollback, sem mover zona ou nameservers.
- ⬜ `0.8.9` — Observabilidade, Backup e Runbooks.
- ⬜ `0.8.10` — Bootstrap Seguro: primeira Organization e owner, sem Leads
  reais ou convites.
- ⬜ `0.8.11` — Smoke e Abertura Controlada: dados sintéticos, desktop/mobile,
  sessão, CRM, isolamento cross-tenant, rollback e decisão humana.

Dependências e DAG canônicos estão em [PRODUCTION.md](PRODUCTION.md). Nenhuma
tarefa planejada prova publicação, prontidão operacional ou autorização para
dados reais. Billing permanece adiado, sem escopo aprovado.
