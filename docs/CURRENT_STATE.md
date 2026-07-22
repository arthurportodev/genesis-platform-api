# Estado atual

- **Última atualização:** 2026-07-22
- **Fase:** 0.2 — Identidade e multi-tenancy
- **Última tarefa funcional concluída:** 0.2.4 — Autorização por papel
- **Última tarefa de governança concluída:** 0.2.2.6 — Normalização de EOL
- **CI da `main`:** aprovado
- **Proteção da `main`:** Pull Request e check `Validate backend` obrigatórios; branch atualizada exigida; force push e exclusão bloqueados
- **Última subtarefa funcional concluída:** 0.2.5.2 — Entrega por email e aceitação para usuário existente (PR #14, squash `410f0576a98e373c39bf178f73b80838b40d2924`, CI pós-merge 29919743498 aprovada)
- **Tarefa funcional em implementação:** 0.2.5.3 — Ativação de usuário novo por convite

## Implementado

- Fundação NestJS 11, Node.js 24, TypeScript estrito e API sob `/api/v1`.
- Configuração validada com Joi, PostgreSQL 17, TypeORM com `synchronize: false`, Docker e health check.
- Módulos de configuração, banco, health, users, organizations, memberships, auth, auth-sessions, tenant-context e authorization.
- Usuários globais, organizações e memberships com papéis `owner`, `admin` e `member`.
- Autenticação por email e senha, sessões persistidas, refresh rotativo e auditoria.
- Rate limit de login em memória e confiança em proxy configurável por saltos.
- Testes unitários, E2E e de integração; CI com build Docker.

### Governança multiagente adotada

- Toda tarefa é classificada como Simple, Normal ou Critical antes da escrita; um único gatilho crítico eleva toda a tarefa.
- O ciclo operacional usa coordenador, builder, verifier e operador de entrega, com ownership exclusivo por arquivo e worktrees para writers paralelos.
- Gate 1 aprova arquitetura quando exigida, Gate 2 aprova a implementação e Gate 3 autoriza explicitamente o merge.
- Findings baixos e uma iteração de finding médio estritamente dentro do contrato podem ser corrigidos e reverificados; riscos de segurança, tenant, dados, schema, API, ownership ou expansão material interrompem o trabalho.
- Código, testes e documentação durável devem integrar um único Pull Request por tarefa; evidências transitórias permanecem no GitHub.
- As Skills `genesis-project-context` e `genesis-task-classification` são candidatas futuras e ainda não foram criadas.
- O GitHub permite somente squash merge; merge commits e rebase merges estão desabilitados, e branches remotas incorporadas são excluídas automaticamente. Nenhuma aprovação obrigatória é prevista enquanto não houver segundo mantenedor humano elegível.
- `.gitattributes` define `* text=auto eol=lf`: arquivos textuais tracked usam LF canônico e binários detectados permanecem sem conversão de texto.
- O inventário atual não exige exceção CRLF nem regra binária específica; falsos diffs `Delete-CR` foram eliminados sem alterar `core.autocrlf`.
- A Tarefa 0.2.2.6 concluiu o primeiro piloto do modelo multiagente. As Skills continuam ausentes e a 0.2.5 permanece planejada e não iniciada.

### Tenant context implementado

- `TenantContextModule` resolve organização e membership ativas a cada request tenant-scoped.
- `TenantContextGuard` recebe `X-Organization-Id` após o `AccessTokenGuard` e anexa contexto tipado à request.
- `TenantContext` contém `userId`, `organizationId`, `membershipId` e papel lido da membership persistida.
- `CurrentTenant` disponibiliza o contexto validado a controllers tenant-scoped futuros.
- Não há guard global ou endpoint tenant-scoped de produção.

### Autorização por papel implementada

- `AuthorizationModule` fornece `RoleGuard` sem acesso ao banco ou estado compartilhado.
- `@Roles` declara listas explícitas de `owner`, `admin` e `member` em controllers ou handlers; metadata do handler prevalece.
- O guard consome exclusivamente o papel já validado no `TenantContext`, não modifica a request, não adiciona consulta e usa negação `403` genérica.
- Metadata ausente, vazia ou malformada, incluindo arrays esparsos e índices herdados, falha fechada com `500`; tenant context ausente também falha explicitamente.
- Não há hierarquia implícita, permissions, policy engine, autorização por recurso ou matriz real de capacidades.
- A infraestrutura foi incorporada à `main` pelo PR #8, com validações do PR e pós-merge aprovadas.
- Ainda não existe consumidor tenant-scoped de produção.

### Endpoints

- `GET /api/v1/health`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/logout-all`
- `GET /api/v1/auth/me`
- `POST /api/v1/invitations` (readiness operacional; produção fail-closed até 0.2.5.3)
- `GET /api/v1/invitations`
- `GET /api/v1/invitations/:invitationId`
- `POST /api/v1/invitations/:invitationId/revoke`
- `POST /api/v1/invitations/:invitationId/replace` (readiness operacional; produção fail-closed até 0.2.5.3)
- `POST /api/v1/invitation-acceptance/inspect`
- `POST /api/v1/invitation-acceptance/accept`
- `POST /api/v1/invitation-acceptance/activate`

Não existem endpoints de CRUD para usuários, organizações ou memberships.

### Convites em implementação

- A 0.2.5.1 foi incorporada à `main` pelo PR #13, squash `829cefa`, com CI do PR e pós-merge aprovadas.
- A 0.2.5.2 foi concluída no PR #14, squash `410f0576a98e373c39bf178f73b80838b40d2924`, com CI pós-merge 29919743498 aprovada.
- A 0.2.5.3 adiciona activation pública para usuário inexistente, credencial Argon2id, Membership, acceptance e auditoria em uma única transação, sem auto-login.
- Em produção, emissão somente abre quando issuance, acceptance, activation, worker, keyring, delivery e frontend estão explicitamente prontos e a API pública opera com uma réplica.

- `OrganizationInvitation` e as tabelas separadas de audit, idempotência e
  outbox implementam o domínio e a administração tenant-scoped da 0.2.5.1.
- Owner administra invitations de `member` e `admin`; admin administra somente
  invitations de `member`, sempre com a cadeia completa de guards e revalidação
  transacional.
- As rotas create/list/get/revoke/replace estão registradas. Create e replace
  usam readiness operacional dependente do banco, keyring e delivery; em
  produção, a emissão permanece fail-closed até a 0.2.5.3.
- O outbox possui worker separado, claim concorrente, retry, fencing,
  dead-letter, adapter Resend e health interno; o provider não participa da
  transação de aceitação.
- A aceitação autenticada para usuário existente está incorporada. A activation
  cria somente usuário novo e nunca converte automaticamente para accept;
  gestão de memberships/ownership permanece na 0.2.5.4.

### Schema

Migrations existentes:

- [`1784400000000-CreateMultiTenantCore.ts`](../src/database/migrations/1784400000000-CreateMultiTenantCore.ts)
- [`1784486400000-CreateAuthSessions.ts`](../src/database/migrations/1784486400000-CreateAuthSessions.ts)
- [`1785004800000-CreateOrganizationInvitations.ts`](../src/database/migrations/1785004800000-CreateOrganizationInvitations.ts)
- [`1785087600000-DeliverInvitationAcceptance.ts`](../src/database/migrations/1785087600000-DeliverInvitationAcceptance.ts)
- [`1785174000000-ActivateNewInvitationUser.ts`](../src/database/migrations/1785174000000-ActivateNewInvitationUser.ts)

Tabelas da aplicação: `users`, `organizations`, `memberships`, `auth_sessions`, `auth_refresh_tokens`, `auth_audit_logs`, `organization_invitations`, `organization_audit_logs`, `organization_command_idempotency` e `invitation_delivery_outbox`.

## Decisões adotadas

- Monólito modular; microservices adiados.
- Banco e schema compartilhados; usuário global e vínculo por membership.
- Papel pertence à membership.
- Migrations são a fonte de verdade do schema.
- JWT contém usuário e sessão, sem organização ou papel.
- Sessão e histórico de refresh tokens persistem no PostgreSQL.
- O contexto implementado recebe `X-Organization-Id`, valida organização e membership ativas no banco e não adiciona tenant ou papel ao JWT.

Consulte os [ADRs](decisions/README.md).

## Limitações conhecidas

- `OrganizationInvitation` é a primeira entidade de domínio tenant-scoped; as demais entidades comerciais ainda não existem.
- A infraestrutura genérica de autorização por papel está implementada; permissions, matriz real de capacidades, autorização por recurso e invariantes de membros ainda não existem.
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
