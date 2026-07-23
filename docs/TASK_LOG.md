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

## 0.2.2.4 — Sistema Operacional de Desenvolvimento Multiagente

**Concluído como tarefa Normal de governança.**

- Classificação Simple, Normal e Critical adotada; um único gatilho crítico eleva toda a tarefa.
- Gate 1 aprova arquitetura quando exigida, Gate 2 aprova implementação e Gate 3 autoriza merge.
- Coordenador, builder, verifier e operador de entrega têm fronteiras e handoffs explícitos.
- Ownership exclusivo por arquivo; writers paralelos exigem branches e worktrees isolados, e operações Git remotas permanecem serializadas.
- Findings baixos e uma iteração de finding médio estritamente dentro do contrato podem ser corrigidos e reverificados; segurança, tenant, dados, schema, API, ownership, finding alto ou expansão de escopo interrompem a execução.
- Código, testes e documentação durável integram um Pull Request por tarefa; metadados transitórios permanecem no GitHub.
- As Skills `genesis-project-context` e `genesis-task-classification` foram adiadas até que pilotos comprovem procedimentos estáveis.
- Normalização de EOL foi definida como primeiro piloto planejado; nenhuma configuração GitHub ou funcionalidade da API foi alterada.

## 0.2.2.5 — Padronização do merge e limpeza automática de branches

**Concluído como tarefa Normal de governança.**

- Somente squash merge é permitido; merge commits e rebase merges foram desabilitados.
- A exclusão automática de branches remotas incorporadas foi ativada; branches locais continuam sendo removidas após sincronização e comprovação.
- O ruleset `Protect main` foi preservado, sem aprovação humana obrigatória enquanto não houver segundo mantenedor humano elegível.
- Nenhuma funcionalidade, workflow, código, teste, migration ou dependência foi alterada.
- A normalização de EOL permanece como próximo piloto planejado.

## 0.2.2.6 — Normalização de EOL

**Concluído como tarefa Normal de governança e infraestrutura.**

- `.gitattributes` adotou a política mínima `* text=auto eol=lf`; arquivos textuais tracked foram materializados em LF canônico.
- Não existe exceção CRLF nem regra binária específica, pois o inventário não identificou caso real; `text=auto` preserva binários fora da conversão de texto.
- A prova byte a byte confirmou zero mudança semântica acidental nos arquivos normalizados.
- Formatação, lint, build, testes unitários, E2E e de integração e build Docker foram aprovados na mesma rodada completa.
- O primeiro piloto multiagente usou ownership exclusivo, handoffs completos e verifier independente; as Skills permanecem adiadas.

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
- Implementação funcional incorporada pelo PR #8, com validações do PR e pós-merge aprovadas e nenhum finding pendente.
- Limites preservados: sem endpoint tenant-scoped de produção, matriz real de capacidades, permissions, hierarquia, policy engine, autorização por recurso, regra de último owner, gestão de membros, migration ou dependência nova.

## 0.2.5.1 — Domínio e administração de convites

**Status: concluída no PR #13, squash `829cefa4cf06f596d0076e4c422e31c26d31e0a5`, com CI pós-merge 29840864674 aprovada.**

- Domínio persistente de invitations com expiração derivada, revogação,
  substituição e token HMAC regenerável sem token/hash bruto persistido.
- Administração tenant-scoped por owner/admin; admin limitado a `member` e
  owner invitation proibida.
- Audit organizacional append-only, idempotência de replace, quotas no banco e
  outbox explícito sem worker/provider.
- Readiness fixa desabilita create/replace até 0.2.5.2; list/get/revoke continuam
  disponíveis.
- Defesas PostgreSQL e porta transacional revogam pendentes quando issuer
  membership/user é inativado; role change não revoga.
- Aceitação, email real, users novos, memberships e last-owner permanecem fora.

## 0.2.5.2 — Entrega por email e aceitação para usuário existente

**Status: concluída no PR #14, squash `410f0576a98e373c39bf178f73b80838b40d2924`, com CI pós-merge 29919743498 aprovada.**

- Provider Resend atrás de porta, outbox transacional e worker separado com idempotência, retry, lease, fencing, recovery e health interno em loopback.
- `inspect` público mínimo e `accept` autenticado derivam tenant, email, papel e estado exclusivamente do convite e do PostgreSQL.
- Membership inexistente é criada, ativa igual é preservada, inativa é reativada na mesma linha e ativa divergente falha com conflito.
- Readiness de acceptance inventaria todas as versões de chave ainda necessárias; falha de chave não chama provider nem morre antes do deadline.
- Nenhum email real é executado pelos testes.

## 0.2.5.3 — Ativação de usuário novo por convite

**Status: concluída no PR #15, squash `945142b3103a24104525d825226ff75c9e5e1f9b`, com CI pós-merge 29933958617 aprovada.**

- `POST /api/v1/invitation-acceptance/activate` recebe exclusivamente token, nome e senha e retorna apenas Organization e Membership, sem sessão ou tokens de autenticação.
- `CredentialsModule` centraliza política e Argon2id por portas opacas; activation confirma o email pela invitation e preenche `email_verified_at` junto de `password_changed_at`.
- User, Membership, acceptance, cancelamento da outbox e auditoria append-only são atômicos por função privada `SECURITY DEFINER` com ACL mínima.
- HMAC e estado são revalidados sob locks Organization → Invitation; corrida de email faz rollback integral e mantém a invitation pending.
- Readiness, dois rate limits e semaphore Argon2 falham fechados; issuance de produção exige todas as precondições explícitas e uma única réplica pública.

## 0.2.5.4 — Gestão de memberships e ownership

**Concluída no PR #16, squash `4392d7347035a216a273ce4395fd9e1bd83ab91b`, com CI pós-merge 29952145756 aprovada.**

- Diretório paginado e consulta de membros sob `/api/v1/members`, com owner
  vendo todos, admin hard-filtered para `member` e member sem diretório.
- Comandos explícitos para papel, promoção a owner, desativação, reativação e
  saída própria; self-target e cross-tenant falham sem ampliar visibilidade.
- Uma única função privada tipada centraliza autorização transacional, ordem de
  locks e resultados `changed`, `no_change` e `blocked_last_owner`.
- Constraint triggers diferidos protegem o owner efetivo em mudanças de
  Organization, User e Membership; vínculo user/organization é imutável.
- Auditoria append-only registra uma mudança, zero para no-op e a tentativa
  bloqueada do último owner com snapshots coerentes e FK tenant-scoped.
- Readiness e migration verificam allowlist exata, ACLs, metadata de funções e
  os triggers de ownership e D7. Runtime permanece sem DML central direto.
- `API_PUBLIC_REPLICA_COUNT` é a variável canônica compartilhada; o nome legado
  é aceito temporariamente e conflito falha fechado.
- Testes reais cobrem preaudit, rollback fail-closed, concorrência do último
  owner, drift de catálogo, matriz owner/admin/member, auditoria, HTTP e
  regressão de activation/invitations/auth.

## 0.2.5 — Convites e gestão de membros

**Concluído.** As tarefas 0.2.5.1 a 0.2.5.4 entregaram administração, entrega e aceitação de convites, ativação de usuário novo, gestão de memberships e invariantes de ownership.

## Fase 0.2 — Identidade e multi-tenancy

**Concluída.** O fechamento ocorreu com o PR #16 no squash `4392d7347035a216a273ce4395fd9e1bd83ab91b`; a CI pós-merge 29952145756 foi aprovada. A descoberta de produto da Fase 0.3 — CRM é o próximo estágio.

## 0.3.1 — Fundação e Inbox de Leads

**Status: candidato local em validação do Gate 2.**

- Modelo tenant-scoped de Lead, Entry append-only, timeline mínima e idempotência técnica.
- Intake manual e relay `genesis_form` dedicado; E.164, deduplicação ativa, Source e UTMs e respostas opacas.
- Inbox, list, detail, edição básica com ETag/If-Match e assignment owner/admin; member limitado aos próprios Leads.
- ACL por funções estreitas, readiness fail-closed, HMAC do corpo bruto e limpeza transacional de assignments no offboarding.
- Pipeline, atividades, notas, busca, métricas, import, WhatsApp e frontend permanecem fora do escopo.
