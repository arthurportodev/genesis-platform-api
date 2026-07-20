# Histórico de tarefas

## 0.1.1 — Fundação do backend

**Concluído.** Criou a base NestJS/TypeScript, configuração validada, PostgreSQL/TypeORM sem sincronização automática, health check `/api/v1/health`, Docker/Compose, tratamento global de erros e testes da fundação.

## 0.2.1 — Núcleo multi-tenant

**Concluído no PR #1.**

- Migration `1784400000000-CreateMultiTenantCore`.
- Tabelas `users`, `organizations` e `memberships`.
- Papéis `owner`, `admin`, `member`; status active/inactive.
- Constraints, índices, foreign keys restritivas e UUID no PostgreSQL.
- Seed inicial transacional e idempotente.
- Testes de migration, rollback, constraints e seed em PostgreSQL descartável.

## 0.2.2 — Autenticação e sessões

**Concluído no PR #2.**

- Migration `1784486400000-CreateAuthSessions`.
- Argon2id e credencial inicial seed-only.
- JWT curto, sessões persistidas e refresh tokens opacos com HMAC.
- Rotação, histórico e detecção de reutilização comprovada.
- Guard com validação da sessão no banco; login, refresh, me, logout e logout-all.
- Auditoria sanitizada, rate limit em memória e trust proxy configurável.
- Testes unitários, E2E e de integração.

## 0.2.2.1 — GitHub Actions CI

**Concluído no PR #3.**

- Workflow `CI` para PRs/pushes da `main` e execução manual.
- Node.js 24, `npm ci` e PostgreSQL 17 descartável.
- Format check, lint, build, testes unitários, E2E e integração.
- Build local da imagem Docker, sem publicação ou deploy.

## 0.2.2.2 — Memória e continuidade

**Concluído no PR #4.**

- Memória oficial e protocolo de reidratação em `AGENTS.md` e `docs/START_HERE.md`.
- Estado, roadmap, arquitetura, domínio, segurança, fluxo de desenvolvimento e histórico documentados.
- Índice de decisões e ADR-001 a ADR-004 criados.
- Template de Pull Request criado para revisar escopo, testes, segurança e continuidade.
- Nenhuma funcionalidade de produto, migration, endpoint ou tabela foi alterada.

## 0.2.2.3 — Proteção da main

**Concluído.**

- Ruleset `Protect main` ativo e limitado à default branch.
- Pull Request obrigatório, sem aprovação humana obrigatória nesta fase.
- Check `Validate backend` obrigatório e branch atualizada com a `main`.
- Resolução de conversas e histórico linear obrigatórios.
- Force push e exclusão da `main` bloqueados.
- Nenhum bypass permanente configurado.
- Nenhuma funcionalidade de produto foi alterada.

## 0.2.3 — Organização ativa e contexto de tenant

**Concluído no PR #6.**

- `TenantContextModule`, `TenantContextGuard`, `TenantContextService`, decorator `CurrentTenant` e tipos de request/contexto.
- Validação de `X-Organization-Id`, organização ativa e membership ativa.
- Papel e membership ID obtidos do PostgreSQL a cada request tenant-scoped.
- Separação entre autenticação e contexto de tenant, com portas modulares opacas para resolução natural dos guards.
- Testes unitários, E2E e de integração; CI do PR e CI pós-merge aprovadas.
- Nenhuma migration ou dependência nova.
- Sem endpoint tenant-scoped de produção ou autorização por papel.

## 0.2.4 — Autorização por papel

**Status: concluída.**

- Objetivo entregue: autorização genérica por papel para rotas tenant-scoped futuras, separada de autenticação e resolução do tenant.
- `AuthorizationModule`, decorator tipado `@Roles` e `RoleGuard` implementados; o módulo exporta somente o guard e não usa TypeORM, entidade, repository, service, controller, migration, estado compartilhado ou porta opaca.
- Cadeia `AccessTokenGuard` → `TenantContextGuard` → `RoleGuard`, com listas explícitas e papel consumido exclusivamente do `TenantContext`, sem consulta adicional ao PostgreSQL.
- Metadata do handler substitui a do controller; configuração ausente, vazia ou malformada e tenant context ausente falham fechados.
- Testes unitários e E2E cobrem os três papéis, composição natural do NestJS, precedência de metadata, negação genérica, mudanças persistidas de papel e ausência de vazamento de política.
- Dois findings baixos foram corrigidos com rejeição explícita de arrays esparsos e índices de array herdados.
- ADR-005 registra a decisão arquitetural como implementada pela Tarefa 0.2.4.
- Implementação funcional no PR #8; commit da branch `ba2661b39a0dd8fa4c65674ba8ed139c8c4107b1`; squash commit `7fb67525fd9301292fcd5bbe063fd3339a09a563`.
- CI do PR, run `29708366038` (`Validate backend`, job `88248886316`), e CI pós-merge da `main`, run `29708662917` (job `88249569684`), aprovadas.
- Nenhuma aprovação humana era obrigatória, nenhuma thread ficou pendente e a branch funcional foi removida após o merge.
- Limites preservados: sem endpoint tenant-scoped de produção, matriz real de capacidades, permissions, hierarquia, policy engine, autorização por recurso, regra de último owner, gestão de membros, migration ou dependência nova.
- Próxima tarefa funcional planejada: 0.2.5 — Convites e gestão de membros; ainda não iniciada.
