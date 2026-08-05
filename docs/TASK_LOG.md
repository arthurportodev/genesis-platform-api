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

**Concluída no PR #18, squash `dbaa1a0430c7b0a65ce28ca20d3eff277aa7cdca`, com CI pós-merge 30000872384 aprovada.**

- Modelo tenant-scoped de Lead, Entry append-only, timeline mínima e idempotência técnica.
- Intake manual e relay `genesis_form` dedicado; E.164, deduplicação ativa, Source e UTMs e respostas opacas.
- Inbox, list, detail, edição básica com ETag/If-Match e assignment owner/admin; member limitado aos próprios Leads.
- ACL por funções estreitas, readiness fail-closed, HMAC do corpo bruto e limpeza transacional de assignments no offboarding.
- Pipeline, atividades, notas, busca, métricas, import, WhatsApp e frontend permaneceram fora do escopo da 0.3.1.

## 0.3.2 — Pipeline comercial, fechamento e retorno

**Concluída no PR #19, squash `6fa39f103b9ebf65f93d26fcbc60504fa47d4e37`, com CI pós-merge 30298541579 aprovada.**

- Estágios fixos `new`, `qualification`, `diagnosis`, `proposal` e `negotiation`, com movimentação livre enquanto o Lead está ativo.
- Fechamentos `won`, `lost` e `archived` preservam o estágio e encerram um ciclo comercial imutável; reativação abre novo ciclo em `qualification`.
- Entradas recebidas para Lead encerrado não reabrem nem reatribuem: agregam uma revisão pendente por Lead, resolvida explicitamente por reativação ou descarte.
- Comandos usam `If-Match`, UUID v4 de idempotência, fingerprint HMAC versionado, resposta `204`, ETag e timeline tipada append-only.
- ACL mínima, readiness de catálogo, invariantes diferidas, rollback fail-closed e testes PostgreSQL cobrem concorrência, replay e isolamento tenant-scoped.

## 0.3.3 — Atividades e Follow-up

**Concluída no PR #20, squash `7c39fede23fd36e2a4c2f17da5043494f5e42ac1`, com CI pós-merge 30310732216 aprovada.**

- Activity e Note são registros tenant-scoped, append-only e vinculados ao ciclo comercial; conteúdo livre permanece nas tabelas canônicas e fora da metadata da timeline.
- Existe no máximo uma Next Action `pending` por Lead, com comandos explícitos de criação, reagendamento, conclusão e cancelamento; conclusão gera uma Activity exatamente uma vez.
- Assignment transfere a pendência, unassignment/offboarding limpam o responsável e fechamento cancela atomicamente com razão `lead_closed`; reativação não restaura pendência.
- `organizations.crm_time_zone` usa IANA e default/backfill `America/Belem`; `overdue`, `today`, `future` e `none` são derivados no PostgreSQL somente na leitura dedicada.
- Timeline passa a ser paginada por sequência e retorna referências tipadas e conteúdo canônico após autorização do Lead.
- O intake `genesis_form` permanece implementado, fail-closed e operacionalmente desabilitado.

## 0.3.4 — Experiência Operacional do CRM

**Concluída no PR #21, squash `f625745b17828a47208cc27461cc8cb6d8d9e67a`.**

- Busca textual NFC por prefixo case-insensitive e accent-sensitive, com telefone completo normalizado por correspondência exata.
- Lista com filtros combináveis, sorts allowlisted, paginação opaca vinculada à consulta e default que exclui somente arquivados.
- Filas de Minhas Ações, Leads sem responsável e Return Reviews, além de Kanban híbrido com cinco previews e continuação por coluna.
- Detalhe consolidado e métricas owner/admin sobre datas civis no timezone da Organization.
- Toda projeção revalida Organization, User, Membership, papel atual e visibilidade por responsável no mesmo statement SQL.
- Migration aditiva contém somente nove índices; readiness valida UTF8, definições, opclasses e predicados sem ampliar ACL.
- O intake `genesis_form` permanece implementado, fail-closed e operacionalmente desabilitado.

## 0.7.0 — Contrato Web de Sessão e Bootstrap

**Concluída no PR #22, squash `9f0fb751f6e506ade1d0e0af0f7f80506b4a93f2`.**

- Access token permanece Bearer tenant-agnostic em JSON; login define o refresh
  cookie e refresh lê, substitui e rotaciona o token exclusivamente por esse
  cookie, sem o contrato anterior de JSON/body.
- CSRF double-submit e validação de `Origin` protegem login, refresh, logout e
  logout-all; CORS usa origem ambiental exata e headers explícitos.
- Logout atual tornou-se idempotente e independente do access token; logout-all
  preserva Bearer e revogação global. Ambos removem cookies.
- `GET /api/v1/auth/bootstrap` retorna user e Organizations/memberships ativas
  do próprio user, com papel persistido e sem tenant header.
- Respostas sensíveis usam `Cache-Control: no-store`; rotação transacional,
  locks, HMAC-only, reuse detection, multi-tenancy e autorização permanecem.
- Testes unitários, E2E e de integração e a documentação durável do contrato
  web foram incorporados com a implementação.
- Sem migration, schema, dependência, frontend ou CRUD de Organization.

## 0.7.1.1 — Bootstrap do Repositório Frontend

**Concluída no repositório `arthurportodev/genesis-platform-web`, PR #1, squash `30b91272088dd9be03b8bd9feffbf74dac48acc7`.**

- Fundação React/Vite/TypeScript com shell administrativo, rotas provisórias,
  design system inicial, testes, CI e Sistema Operacional de Desenvolvimento.
- Sessão real, cliente HTTP, Organization ativa, guards, coordenação de refresh,
  proxy same-origin, Vercel e deploy permaneceram fora da 0.7.1.1.

## 0.7.0.2 — Reconciliação do Estado Web nos Documentos do Backend

**Concluída no PR #24, squash
`57f6955b3a90a29517d5477e75aac97032425ed1`.**

- Corrige a memória oficial após a incorporação da 0.7.0 no backend e da
  fundação 0.7.1.1 no repositório frontend separado, sem mudança funcional.
- Reconcilia ADR-010, segurança, arquitetura, estado atual, roadmap e histórico;
  nenhum código, teste, contrato, schema, migration ou dependência foi alterado.
- A incorporação preservou Preview fail-closed e nenhum acesso à produção.
- Validações: perfil `docs`, fingerprint determinístico, `git diff --check` e
  revisão independente read-only.

## 0.7.1.2 — Sessão Web, Organization Ativa e HTTP

**Concluída no frontend, PR #2, squash
`633ace9b55ec25e70f1f88089865f89db464ed5f`.**

- Sessão em memória, refresh cookie-only, CSRF, coordenação multiaba,
  bootstrap, Organization ativa, cache tenant, guards e cliente HTTP.
- Backend canônico lido no SHA
  `57f6955b3a90a29517d5477e75aac97032425ed1`; sem alteração backend.

## 0.7.2 — Inbox e Detalhe

**Concluída no frontend, PR #3, squash
`859823501bbdee03441a9fa865d823f3890be07a`.**

- Inbox, filtros, paginação, detalhe, timeline, próxima ação, ciclos,
  diretório por papel e mutações server-confirmed.

## 0.7.3 — Pipeline Kanban

**Concluída no frontend, PR #4, squash
`1040523fa4b415e1cdf25d7f61085c3765f33eb9`.**

- Cinco estágios canônicos, filtros, paginação por coluna, PII minimizada e
  movimento server-confirmed com ETag, If-Match e Idempotency-Key.

## 0.7.4 — Follow-up e Filas Operacionais

**Concluída no frontend, PR #5, squash
`f9fc37dd31fa2116a66354d46938c60d566fe101`.**

- Filas por papel, ações atrasadas/de hoje/futuras, sem responsável, retornos
  para revisão e ações rápidas server-confirmed.

## 0.7.5 — Métricas Operacionais

**Concluída no frontend, PR #6, squash
`1ac7e26cda535cbf3e5c02dd78da4e0fb95a2e9e`.**

- Snapshot, período civil, origem e taxa de ganho para owner/admin, com
  timezone da Organization e sem polling.

## 0.7.6 — Criação Manual de Leads

**Concluída no frontend, PR #7, squash
`4e4f8db0fcd31a4280d72f8cba0a1e0b47f4fa92`.**

- `/app/leads/new`, contrato server-confirmed, respostas por papel,
  idempotência somente em memória, incerteza explícita e proteção de PII.
- Sem importação, formulário público, comunicação externa, Vercel ou deploy.

## Fase 0.7 — Frontend operacional

**Concluída.** O ciclo funcional documentado é criar Lead → Inbox → detalhe →
Pipeline → Follow-up → métricas. Importação, formulário público conectado,
WhatsApp, automações, calendário, estágios customizáveis, drag-and-drop e
produção permanecem indisponíveis.

## 0.8.0 — Arquitetura e Plano de Produção

- Natureza: Gate 1 técnico e operacional, estritamente read-only.
- Resultado: Gate 1 recomendado com decisões humanas pendentes; decisões
  aprovadas pelo Product Owner em 30 de julho de 2026.
- Evidências negativas: sem branch, alteração de arquivo, PR, build, migration,
  seed, mudança em Vercel/DNS/Hetzner ou deploy.
- Decisão: Vercel + proxy `/api/v1` + origem protegida + Traefik + API NestJS
  - PostgreSQL, com uma réplica pública e abertura controlada.

## 0.8.1 — Reconciliação Canônica da Documentação

- Classe/perfil: Normal / docs.
- Responsabilidade: frontend e backend, com um único builder e consistência
  entre os dois candidatos.
- Resultado esperado: memória canônica, decisões aceitas, plano
  `0.8.1`–`0.8.11`, DAG e critérios de produção.
- Limites: exclusivamente documental; sem código, infraestrutura ou operação
  remota.

A tarefa foi incorporada no backend pelo PR #25, squash
`6a1a5bafc14195cbd8cf6f8b85077a4e1081381c`, e no frontend pelo PR #8,
squash `bfe7c81fca34f723677e2fe5097598d92f487838`.

## 0.8.1.1 — Sistema Operacional de Desenvolvimento V2

- Classe/perfil: Critical / critical.
- Estado: incorporada serialmente no backend pelo PR #26, squash
  `27d85416507ae4d8391d74b4181f8400c6d61301`, e no frontend pelo PR #9,
  squash `890a49fb62fd194f8c2adf04fbfeb0cdd84e32bf`.
- CIs pós-merge: backend `30567270626` e frontend `30567803632`, ambas
  aprovadas sem checks pendentes.
- Entrega: contrato operacional V2 vigente, Task Manifest dual-read V1/V2,
  fingerprints separados, candidate ID, Skills repo-local, schemas, checks e
  evidência independente.
- Autoridade e paridade: backend canônico; frontend com os nove contratos
  compartilhados byte a byte equivalentes à árvore incorporada no backend.
- Findings: F-001 a F-008 resolvidos; zero findings novos e zero limitações no
  fechamento dos candidatos aprovados.
- Limites: operador remoto ainda não implementado; sem deploy, infraestrutura,
  banco, migrations, secrets ou mutação de produção.
- Próxima tarefa registrada à época: `0.8.2` — Hardening e Imagem de Produção
  da API, ainda não iniciada; essa sequência foi posteriormente superseded.

## Rebaseline da primeira produção do MVP

**Decisão de 3 de agosto de 2026.** A estratégia de produção descrita pelo
ADR-011 e pela sequência histórica `0.8.2`–`0.8.11` foi superseded por uma
baseline proporcional ao MVP. O experimento legado, inclusive o PR #28, não é
fonte para promoção automática de implementação. O ADR-013 passa a registrar a
decisão vigente.

## Workspace independente da 0.8-MVP

**Criado e validado.** A nova sequência usa workspace e branch independentes,
sem reutilizar a branch ou os commits do experimento anterior. Nenhuma mutação
de produção foi autorizada pela criação do workspace.

## 0.8-MVP-01 — Runtime health

**Concluída e incorporada.** Implementou lifecycle
`starting → ready → draining → stopped`, liveness independente do PostgreSQL,
readiness com `SELECT 1`, endpoints públicos e internos sanitizados e shutdown
coordenado com deadline finito.

O code review identificou o finding bloqueante `MVP-RH-001`: o listener
customizado podia absorver o segundo sinal emitido pelo Nest e permitir que o
deadline expirasse após hooks bem-sucedidos. A correção habilitou saída
explícita após os hooks e recebeu regressão focal.

O candidato corrigido passou por code review, testes focais e regressivos e
verificação independente autocontida, com cobertura 9/9, prova de shutdown de
processo e zero finding remanescente. A implementação foi registrada no commit
`c2e39cee2ea05f6e0a23edd150268024b2ebe94c` e incorporada à `main` pelo PR #29
no squash `5e76b4fde61badce3a39792f7ba9e3ee6ea806ce`.

## 0.8-MVP-02 — Rebaseline documental de produção

**Concluída e incorporada.** Tarefa Critical exclusivamente documental que
criou o ADR-013, marcou o ADR-011 como superseded, substituiu a antiga autoridade
operacional e registrou a nova sequência linear `0.8-MVP`. Não incluiu código,
Docker, infraestrutura, remoto, publicação ou dados reais.

## 0.8-MVP-02.1 — Reconciliação do contrato documental da CI

**Concluída e incorporada.** A execução inicial de CI `30867100158` falhou em
`test:task-tools` porque a rebaseline removeu acidentalmente o registro
conceitual do operador remoto. A correção no commit
`f94eab1a4f02b520f176ed99b5898b25d2be8d97` o restaurou somente como backlog
futuro, sujeito a tarefa própria e autorização humana separada, e não como
requisito do primeiro MVP. A CI do head `30891501079` foi aprovada.

## 0.8-MVP-02.2 — Closeout pós-merge e transição para 0.8-MVP-03

**Closeout documental de 4 de agosto de 2026.** O Gate 3 do PR #29 foi aprovado
e a baseline com `0.8-MVP-01`, `0.8-MVP-02` e `0.8-MVP-02.1` foi incorporada à
`main` no squash `5e76b4fde61badce3a39792f7ba9e3ee6ea806ce`. A CI pós-merge
`30892867828` foi aprovada integralmente. O PR #28 foi superseded pelo PR #29,
fechado sem merge e preservado apenas como histórico, sem promoção para o MVP.

Nenhum deploy, infraestrutura, imagem ou dado real foi publicado ou autorizado
por esse merge. A tarefa atual passa a ser `0.8-MVP-03 — Container e Compose de
produção`; esse registro não inicia nem aprova sua implementação.

## 0.8-MVP-03 — Container e Compose de produção

**Concluída e incorporada.** O PR #31 foi incorporado no squash
`a568745025091bd3d309052ebd780374da405e3c`, com CI pós-merge `31000957615`
aprovada. Consolidou o target Docker `production` com Node.js 24, UID/GID fixos
não-root e conteúdo mínimo; criou `compose.production.yml` com `postgres`,
`migrate` e `api`; separou roles e credenciais; manteve banco e API sem portas
publicadas; e aplicou health, filesystem read-only, hardening, limites
provisórios e rotação de logs.

A validação local usou imagem identificável, project name e volume exclusivos,
valores sintéticos e nenhuma infraestrutura real. Comprovou migrations
one-shot e idempotentes, privilégio mínimo da role runtime, persistência após
restart, transição e recuperação da readiness, liveness independente, ausência
de secrets nos logs e shutdown por SIGTERM dentro da tolerância. O volume de
evidência local foi preservado; containers e redes transitórios foram removidos.

O merge não publicou imagem, não implantou infraestrutura e não acessou VPS ou
dados reais.

## 0.8-MVP-04 — CI essencial, GHCR e imagem identificável

**Candidata local corrigida, pendente da Gate 2.** Divide a CI em `validate`,
`build-and-scan` para PR/manual e `publish-image` somente para push da `main`.
O build usa o target `production` para `linux/amd64`, aplica seis labels OCI e
uma única tag `sha-<SHA completo>`. Trivy v0.70.0 bloqueia Critical, inclusive
sem correção, antes de qualquer push.

O publicador usa somente `GITHUB_TOKEN`, com `packages: write` restrito ao job.
Tag ausente segue build único, registra o config digest local, executa runtime e
scan, revalida a mesma configuração no único push e seleciona o digest reportado
por ele. A confirmação final consulta somente essa referência imutável e compara
os digests de manifesto e configuração esperados. Tag existente é validada e
reescaneada por digest sem rebuild ou overwrite, preservando os dois digests.
`image-identity.json` registra digest, commit, run e labels por 14 dias. Actions
são fixadas por SHA completo e contratos Node-stdlib cobrem eventos, permissões,
ordem, identidade, idempotência e limites de supply chain.

Formatação, lint, build, unitários, E2E, integração, task-tools, contratos da
CI, 34 testes de produção e validação real do Compose foram aprovados. O scan
local inicial encontrou `CVE-2026-59873`, Critical, em `tar` 7.5.16 da
superfície npm herdada pelo runtime. Arthur ampliou a Gate 1 de 9 para 11 paths,
adicionando somente `Dockerfile` e o teste estrutural da imagem.

Os estágios de dependências/build usam `node:24-alpine3.24`; o estágio final usa
Alpine 3.24 e copia apenas o binário Node, `libstdc++`, dependências podadas,
`dist` e `package.json`. Inspeção real confirmou Node e TypeORM CLI funcionais,
UID/GID 10001, CMD direto, seis labels e ausência de npm, npx, Yarn, Corepack,
módulos globais, conteúdo de desenvolvimento e pacote npm `tar`. Migration
exit 0, readiness 200/healthy e SIGTERM concluído em 2,26 s com exit 0. Trivy
v0.70.0 com base atualizada retornou zero vulnerabilidades Critical, sem ignore
ou allowlist.

A primeira verificação independente cobriu 11/11 paths e bloqueou a Gate 2 com
dois findings High: o artefato ainda podia reinspecionar a tag mutável depois do
scan, e os resultados finais estavam resumidos sem logs brutos vinculados por
hash. A correção substituiu a releitura da tag pelo encadeamento de outputs
imutáveis descrito acima e ampliou os contratos da CI para 29 casos, incluindo
mutações adversariais de digest hard-coded, referência alheia, perda da igualdade
de digests e troca da configuração local. A matriz e as provas operacionais e de
Trivy serão regeneradas como evidência raw/hash-bound antes da reverificação.

Nesta etapa local não houve login ou publicação no GHCR, stage, commit, push,
PR, merge, mudança remota, infraestrutura ou deploy. A primeira criação do
package privado permanece vinculada à autorização humana explícita da Gate 3.
