# Estado atual

- **Última atualização:** 2026-07-19
- **Fase:** 0.2 — Identidade e multi-tenancy
- **Última tarefa funcional concluída:** 0.2.2.1 — GitHub Actions CI
- **Tarefa documental desta entrega:** 0.2.2.2 — Memória, documentação e continuidade (PR #4)
- **CI da `main`:** aprovado
- **Próxima funcionalidade:** 0.2.3 — Organização ativa e contexto de tenant
- **Depois:** 0.2.4 — Autorização por papel; 0.2.5 — Convites e gestão de membros

## Implementado

- Fundação NestJS 11, Node.js 24, TypeScript estrito e API sob `/api/v1`.
- Configuração validada com Joi, PostgreSQL 17, TypeORM com `synchronize: false`, Docker e health check.
- Módulos de configuração, banco, health, users, organizations, memberships, auth e auth-sessions.
- Usuários globais, organizações e memberships com papéis `owner`, `admin` e `member`.
- Autenticação por email e senha, sessões persistidas, refresh rotativo e auditoria.
- Rate limit de login em memória e confiança em proxy configurável por saltos.
- Testes unitários, E2E e de integração; CI com build Docker.

### Endpoints

- `GET /api/v1/health`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/logout-all`
- `GET /api/v1/auth/me`

Não existem endpoints de CRUD para usuários, organizações ou memberships.

### Schema

Migrations existentes:

- [`1784400000000-CreateMultiTenantCore.ts`](../src/database/migrations/1784400000000-CreateMultiTenantCore.ts)
- [`1784486400000-CreateAuthSessions.ts`](../src/database/migrations/1784486400000-CreateAuthSessions.ts)

Tabelas da aplicação: `users`, `organizations`, `memberships`, `auth_sessions`, `auth_refresh_tokens` e `auth_audit_logs`.

## Decisões adotadas

- Monólito modular; microservices adiados.
- Banco e schema compartilhados; usuário global e vínculo por membership.
- Papel pertence à membership.
- Migrations são a fonte de verdade do schema.
- JWT contém usuário e sessão, sem organização ou papel.
- Sessão e histórico de refresh tokens persistem no PostgreSQL.
- O contexto planejado de organização será informado por `X-Organization-Id` e validado no backend; implementação pendente na tarefa 0.2.3.

Consulte os [ADRs](decisions/README.md).

## Limitações conhecidas

- Organização ativa, tenant context e proteção por `organization_id` ainda não existem.
- Autorização por papel e invariantes de membros ainda não existem.
- Refresh token é retornado em JSON; cookie `HttpOnly` não foi decidido/implementado.
- Rate limiter é local, não distribuído e perde estado ao reiniciar.
- Não há política de retenção para sessões e auditoria.
- Não há deploy, frontend, recuperação de senha, confirmação de email ou integrações.

## Decisões abertas e riscos

- Estratégia final de cookie e integração com frontend.
- Retenção e limpeza de sessões, tokens e logs de auditoria.
- Rotação operacional de segredos.
- Armazenamento distribuído do rate limiter quando houver múltiplas réplicas.
- Momento e desenho de uma defesa adicional no banco, como PostgreSQL RLS.
- Topologia e controles do primeiro ambiente de produção.

## Fora do escopo atual

CRM, comunicação, WhatsApp, automações, tracking, relatórios, billing, frontend e deploy permanecem planejados ou futuros; nenhum deles está implementado.
