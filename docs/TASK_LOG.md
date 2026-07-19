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

**Em andamento na branch `docs/project-continuity`.**

- Criação da memória oficial, protocolo de reidratação, documentação arquitetural, segurança, roadmap, histórico, ADRs e template de Pull Request.
- Nenhuma funcionalidade de produto faz parte desta tarefa.
