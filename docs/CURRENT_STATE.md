# Estado atual

- **Última atualização:** 2026-07-30
- **Fase concluída:** 0.7 — Frontend operacional
- **Fase atual:** 0.8 — Infraestrutura e produção
- **Última tarefa funcional concluída:** 0.7.6 — Criação Manual de Leads
  (repositório `arthurportodev/genesis-platform-web`, PR #7, squash
  `4e4f8db0fcd31a4280d72f8cba0a1e0b47f4fa92`)
- **Gate técnico concluído:** 0.8.0 — Arquitetura e Plano de Produção,
  estritamente read-only; decisões humanas aprovadas em 30 de julho de 2026
- **Tarefa de governança atual:** 0.8.1.1 — Evolução do Sistema Operacional de
  Desenvolvimento. O backend implementa primeiro a autoridade canônica; o
  candidato frontend e sua paridade permanecem etapa sequencial obrigatória.
- **Última tarefa de governança concluída:** 0.2.2.6 — Normalização de EOL
- **CI da `main`:** aprovado
- **Proteção da `main`:** Pull Request e check `Validate backend` obrigatórios; branch atualizada exigida; force push e exclusão bloqueados

## Implementado

- Fundação NestJS 11, Node.js 24, TypeScript estrito e API sob `/api/v1`.
- Configuração validada com Joi, PostgreSQL 17, TypeORM com `synchronize: false`, Docker e health check.
- Módulos de configuração, banco, health, users, organizations, memberships, auth, auth-sessions, tenant-context e authorization.
- Usuários globais, organizações e memberships com papéis `owner`, `admin` e `member`.
- Autenticação por email e senha, sessões persistidas, refresh rotativo e auditoria.
- Rate limit de login em memória e confiança em proxy configurável por saltos.
- Testes unitários, E2E e de integração; CI com build Docker.
- Fundação 0.3.1 incorporada com `Lead`, `LeadEntry`, timeline, intake manual e `genesis_form` fail-closed, deduplicação E.164, idempotência durável, inbox tenant-scoped, edição básica e assignment.
- Pipeline 0.3.2 incorporado com ciclos comerciais imutáveis, fechamento ganho/perdido/arquivado, reativação, revisão agregada de retornos e comandos idempotentes.
- Atividades e Follow-up 0.3.3 incorporados com Activity e Note append-only, Next Action única, timezone IANA da Organization e timeline operacional paginada.
- Experiência Operacional 0.3.4 incorporada no PR #21, squash
  `f625745b17828a47208cc27461cc8cb6d8d9e67a`, com busca NFC por prefixo e
  telefone exato, filtros e cursores opacos, filas operacionais, Kanban
  híbrido, detalhe consolidado e métricas owner/admin.
- Contrato Web de Sessão e Bootstrap 0.7.0 incorporado no PR #22, squash
  `9f0fb751f6e506ade1d0e0af0f7f80506b4a93f2`, com refresh exclusivamente em
  cookie protegido, CSRF cookie-to-header, logout idempotente sem dependência de
  access token, CORS/cache explícitos e bootstrap autenticado das Organizations
  disponíveis.
- Fundação frontend 0.7.1.1 incorporada no repositório separado
  `arthurportodev/genesis-platform-web` pelo PR #1, squash
  `30b91272088dd9be03b8bd9feffbf74dac48acc7`, com React/Vite/TypeScript, shell
  administrativo, rotas provisórias, design system inicial, testes, CI e
  Sistema Operacional de Desenvolvimento.
- Sessão web e Organization ativa `0.7.1.2`, Inbox/detalhe `0.7.2`, Pipeline
  `0.7.3`, Follow-up `0.7.4`, Metrics `0.7.5` e criação manual `0.7.6`
  incorporados no frontend pelos PRs #2–#7, com os squashes canônicos
  registrados no [TASK_LOG.md](TASK_LOG.md).

### Governança multiagente adotada

- Toda tarefa é classificada como Simple, Normal ou Critical antes da escrita; um único gatilho crítico eleva toda a tarefa.
- O ciclo operacional usa coordenador, builder, verifier e operador de entrega, com ownership exclusivo por arquivo e worktrees para writers paralelos.
- Gate 1 aprova arquitetura quando exigida, Gate 2 aprova a implementação e Gate 3 autoriza explicitamente o merge.
- Correções mecânicas e funcionais locais dentro do contrato congelado podem ser corrigidas e reverificadas autonomamente; produto, segurança, tenant, dados, schema, API, ownership, concorrência ou expansão material interrompem o trabalho.
- Código, testes e documentação durável devem integrar um único Pull Request por tarefa; evidências transitórias permanecem no GitHub.
- As Skills repo-local `genesis-task-orchestrator` e
  `genesis-independent-verifier` substituem as candidatas anteriores. Schemas,
  scripts, testes e CI permanecem a autoridade determinística.
- Task Manifest V2 coexiste com V1; fingerprints separam conteúdo, estado Git e
  candidate ID; a CI valida as ferramentas operacionais.
- O GitHub permite somente squash merge; merge commits e rebase merges estão desabilitados, e branches remotas incorporadas são excluídas automaticamente. Nenhuma aprovação obrigatória é prevista enquanto não houver segundo mantenedor humano elegível.
- `.gitattributes` define `* text=auto eol=lf`: arquivos textuais tracked usam LF canônico e binários detectados permanecem sem conversão de texto.
- O inventário atual não exige exceção CRLF nem regra binária específica; falsos diffs `Delete-CR` foram eliminados sem alterar `core.autocrlf`.
- A Tarefa 0.2.2.6 concluiu o primeiro piloto do modelo multiagente; a
  lacuna de Skills repo-local foi encerrada pela Tarefa 0.8.1.1, e o bloco
  0.2.5 e a Fase 0.2 permanecem concluídos.

### Tenant context implementado

- `TenantContextModule` resolve organização e membership ativas a cada request tenant-scoped.
- `TenantContextGuard` recebe `X-Organization-Id` após o `AccessTokenGuard` e anexa contexto tipado à request.
- `TenantContext` contém `userId`, `organizationId`, `membershipId` e papel lido da membership persistida.
- `CurrentTenant` disponibiliza o contexto validado a controllers tenant-scoped futuros.
- Não há guard global; invitations e memberships são consumidores tenant-scoped de produção.

### Autorização por papel implementada

- `AuthorizationModule` fornece `RoleGuard` sem acesso ao banco ou estado compartilhado.
- `@Roles` declara listas explícitas de `owner`, `admin` e `member` em controllers ou handlers; metadata do handler prevalece.
- O guard consome exclusivamente o papel já validado no `TenantContext`, não modifica a request, não adiciona consulta e usa negação `403` genérica.
- Metadata ausente, vazia ou malformada, incluindo arrays esparsos e índices herdados, falha fechada com `500`; tenant context ausente também falha explicitamente.
- Não há hierarquia implícita, permissions, policy engine, autorização por recurso ou matriz real de capacidades.
- A infraestrutura foi incorporada à `main` pelo PR #8, com validações do PR e pós-merge aprovadas.
- Invitations e memberships compõem a cadeia completa de guards em produção.

### Endpoints

- `GET /api/v1/health`
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/csrf`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `POST /api/v1/auth/logout-all`
- `GET /api/v1/auth/me`
- `GET /api/v1/auth/bootstrap`
- `POST /api/v1/invitations` (readiness operacional consolidada pela 0.2.5.3, incorporada à `main` no PR #15)
- `GET /api/v1/invitations`
- `GET /api/v1/invitations/:invitationId`
- `POST /api/v1/invitations/:invitationId/revoke`
- `POST /api/v1/invitations/:invitationId/replace` (readiness operacional consolidada no squash `945142b3103a24104525d825226ff75c9e5e1f9b` da 0.2.5.3)
- `POST /api/v1/invitation-acceptance/inspect`
- `POST /api/v1/invitation-acceptance/accept`
- `POST /api/v1/invitation-acceptance/activate`
- `GET /api/v1/members`
- `GET /api/v1/members/:membershipId`
- `PATCH /api/v1/members/:membershipId/role`
- `POST /api/v1/members/:membershipId/promote-owner`
- `POST /api/v1/members/:membershipId/deactivate`
- `POST /api/v1/members/:membershipId/reactivate`
- `POST /api/v1/members/me/leave`
- `POST /api/v1/leads`
- `GET /api/v1/leads`
- `GET /api/v1/leads/kanban`
- `GET /api/v1/leads/work/my-actions`
- `GET /api/v1/leads/work/unassigned` (owner/admin)
- `GET /api/v1/leads/work/return-reviews` (owner/admin)
- `GET /api/v1/leads/metrics/summary` (owner/admin)
- `GET /api/v1/leads/:leadId`
- `GET /api/v1/leads/:leadId/timeline`
- `GET /api/v1/leads/:leadId/next-action`
- `GET /api/v1/leads/:leadId/cycles`
- `PATCH /api/v1/leads/:leadId`
- `PATCH /api/v1/leads/:leadId/assignment`
- `POST /api/v1/leads/:leadId/activities`
- `POST /api/v1/leads/:leadId/notes`
- `POST /api/v1/leads/:leadId/next-action`
- `POST /api/v1/leads/:leadId/next-action/reschedule`
- `POST /api/v1/leads/:leadId/next-action/complete`
- `POST /api/v1/leads/:leadId/next-action/cancel`
- `POST /api/v1/leads/:leadId/move`
- `POST /api/v1/leads/:leadId/win`
- `POST /api/v1/leads/:leadId/lose`
- `POST /api/v1/leads/:leadId/archive`
- `POST /api/v1/leads/:leadId/reactivate`
- `POST /api/v1/leads/:leadId/return-review/dismiss`
- `POST /api/v1/lead-intake/genesis-form` (fail-closed até homologação do relay real)

Não existem endpoints de CRUD para usuários ou organizações. Memberships usam
comandos explícitos de papel, ciclo de vida e saída, sem hard delete.

### Convites e memberships concluídos

- A 0.2.5.1 foi incorporada à `main` pelo PR #13, squash `829cefa`, com CI do PR e pós-merge aprovadas.
- A 0.2.5.2 foi concluída no PR #14, squash `410f0576a98e373c39bf178f73b80838b40d2924`, com CI pós-merge 29919743498 aprovada.
- A 0.2.5.3 foi concluída no PR #15, squash `945142b3103a24104525d825226ff75c9e5e1f9b`, com CI pós-merge 29933958617 aprovada; activation pública para usuário inexistente cria credencial Argon2id, Membership, acceptance e auditoria em uma única transação, sem auto-login.
- A 0.2.5.4 foi concluída no PR #16, squash `4392d7347035a216a273ce4395fd9e1bd83ab91b`, com CI pós-merge 29952145756 aprovada; diretório e comandos de membership preservam ownership efetivo, ACL mínima e auditoria sob concorrência.
- Em produção, emissão somente abre quando issuance, acceptance, activation, worker, keyring, delivery e frontend estão explicitamente prontos e a API pública opera com uma réplica.

- `OrganizationInvitation` e as tabelas separadas de audit, idempotência e
  outbox implementam o domínio e a administração tenant-scoped da 0.2.5.1.
- Owner administra invitations de `member` e `admin`; admin administra somente
  invitations de `member`, sempre com a cadeia completa de guards e revalidação
  transacional.
- As rotas create/list/get/revoke/replace estão registradas. Create e replace
  usam readiness operacional dependente do banco, keyring e delivery,
  consolidada pela 0.2.5.3 no PR #15, com CI pós-merge 29933958617 — success.
  A gestão de memberships e as invariantes de ownership concluíram o bloco
  0.2.5 no PR #16.
- O outbox possui worker separado, claim concorrente, retry, fencing,
  dead-letter, adapter Resend e health interno; o provider não participa da
  transação de aceitação.
- A aceitação autenticada para usuário existente está incorporada. A activation
  cria somente usuário novo e nunca converte automaticamente para accept. A
  gestão de memberships e ownership está incorporada.

### Schema

Migrations existentes:

- [`1784400000000-CreateMultiTenantCore.ts`](../src/database/migrations/1784400000000-CreateMultiTenantCore.ts)
- [`1784486400000-CreateAuthSessions.ts`](../src/database/migrations/1784486400000-CreateAuthSessions.ts)
- [`1785004800000-CreateOrganizationInvitations.ts`](../src/database/migrations/1785004800000-CreateOrganizationInvitations.ts)
- [`1785087600000-DeliverInvitationAcceptance.ts`](../src/database/migrations/1785087600000-DeliverInvitationAcceptance.ts)
- [`1785174000000-ActivateNewInvitationUser.ts`](../src/database/migrations/1785174000000-ActivateNewInvitationUser.ts)
- [`1785260400000-ManageMembershipOwnership.ts`](../src/database/migrations/1785260400000-ManageMembershipOwnership.ts)
- [`1785346800000-CreateLeadFoundation.ts`](../src/database/migrations/1785346800000-CreateLeadFoundation.ts)
- [`1785433200000-ManageLeadCommercialPipeline.ts`](../src/database/migrations/1785433200000-ManageLeadCommercialPipeline.ts)
- [`1785519600000-ManageLeadActivitiesFollowUp.ts`](../src/database/migrations/1785519600000-ManageLeadActivitiesFollowUp.ts)
- [`1785606000000-AddLeadOperationalReadIndexes.ts`](../src/database/migrations/1785606000000-AddLeadOperationalReadIndexes.ts)

O CRM acrescenta `leads`, `lead_entries`, `lead_timeline_events`,
`lead_ingest_idempotency`, `lead_commercial_cycles`, `lead_return_reviews`,
`lead_command_idempotency`, `lead_activities`, `lead_notes`,
`lead_next_actions` e `lead_follow_up_idempotency` às tabelas de identidade,
convites e memberships. `organizations.crm_time_zone` define o contexto IANA
usado somente para projeções temporais derivadas.

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

- Leads são a primeira fronteira comercial tenant-scoped; busca, filas, Kanban,
  detalhe consolidado e métricas operacionais estão incorporados.
- A infraestrutura genérica de autorização por papel e as invariantes de
  ownership estão implementadas; permissions, matriz geral de capacidades e
  autorização por recurso permanecem futuras.
- Coordenação de refresh concorrente entre abas está implementada no frontend;
  o backend preserva reuse detection sem grace period.
- Rate limiter é local, não distribuído e perde estado ao reiniciar.
- Não há política de retenção para sessões e auditoria.
- Sessão, cliente HTTP, Organization ativa, guards e CRM estão implementados no
  frontend. Proxy same-origin de produção, projeto Vercel, domínio, DNS,
  Hetzner, banco de produção, restore, observabilidade e deploy não estão.
- Preview permanece sem API e nunca aponta para produção; staging não será
  criado inicialmente.

## Decisões abertas e riscos

- Implementação e validação da estratégia same-origin já aprovada.
- Retenção e limpeza de sessões, tokens e logs de auditoria.
- Rotação operacional de segredos.
- Armazenamento distribuído do rate limiter quando houver múltiplas réplicas.
- Momento e desenho de uma defesa adicional no banco, como PostgreSQL RLS.
- Inventário e confirmação da capacidade da VPS para a topologia aprovada.
- Provedor de object storage para backups e ferramenta de monitoramento.

## Fora do escopo atual

Importação, comunicação, WhatsApp, automações, tracking, relatórios, billing e
deploy permanecem planejados ou futuros.
O intake `genesis_form` continua fail-closed e operacionalmente desabilitado.
Dados reais permanecem bloqueados até restore, smoke sintético, alertas,
proteção da origem, bloqueio das portas internas, rotação da credencial inicial
e aprovação humana específica.
