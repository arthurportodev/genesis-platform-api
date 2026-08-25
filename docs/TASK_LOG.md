<!-- genesis-memory-history:v1 -->

# Histórico de tarefas

Este registro é histórico e append-only. Nenhum “atual” ou “próximo” registrado
em uma entrada antiga substitui `docs/memory/project-state.v1.json`.

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

**Concluída integralmente após correção.** O PR #32 entrou na `main` no
squash `c02af719c72277f49348de33762ff12dc589434d`. A execução pós-merge
`31023264462` aprovou validação, build único `production/linux/amd64`, runtime,
Trivy v0.70.0 com zero Critical e push. O package foi publicado com sucesso,
mas o job falhou depois do push e não enviou `image-identity.json`.

O incidente foi um falso negativo determinístico: `docker buildx imagetools
inspect --format '{{json .Manifest}}'` retornou apenas o descriptor com
`mediaType`, `digest` e `size`; o workflow tentou ler `config.digest` desse
objeto. A imagem publicada estava íntegra. A tag histórica é
`sha-c02af719c72277f49348de33762ff12dc589434d`, o manifest digest é
`sha256:c839d9d89aa12648e147eebfc2d5b5a09c62080ff50881318e2984ea51ccdc69`
e o config digest é
`sha256:c4bccf7a8e37aa73d46d6717876841a3fe6e343797753786150f8f350c649d9f`.

Arthur aprovou manter público o package
`ghcr.io/arthurportodev/genesis-platform-api`. O repositório também é público,
a imagem sanitizada contém somente runtime e artefatos de produção, e não foram
encontrados secrets ou vulnerabilidades. Não haverá exclusão, recriação ou
mudança de visibilidade. A integridade continua baseada em tag SHA completa,
digests, labels OCI, scans e permissões mínimas; “Latest” na interface não é uma
tag `latest`, e também não existe tag `main`.

## 0.8-MVP-04-CORR-01 — Identidade remota e evidências do GHCR

**Concluída e incorporada.** O PR #33 entrou na `main` no squash
`c6fbc0b865540abd9d13f93c7cc7542eb0936355`. O descriptor passa a fornecer
somente o manifest digest, o manifesto OCI bruto obtido por `--raw`
fornece `config.digest` e `.Image` fornece `linux/amd64` e as seis labels OCI.
Os caminhos de tag nova e existente permanecem fail-closed e idempotentes; tag
existente nunca é reconstruída ou sobrescrita.

Depois da identidade, a API oficial do GitHub verifica existência do package,
visibilidade `public`, vínculo exato com o repositório, versão correspondente ao
digest, única tag SHA na versão selecionada e ausência de `latest`/`main`. O
Trivy v0.70.0 reescaneia a referência remota por digest antes da geração do
artifact. Só então `image-identity.json` é criado em modo `0600`, com os dois
digests, referência imutável, commit, run, plataforma, labels, scanner,
resultado e vínculo do package, para retenção de 14 dias.

A execução pós-merge `31249557339` aprovou validação, runtime, Trivy v0.70.0
local, único push, identidade remota, package público, rescan por digest e
artifact. A tag `sha-c6fbc0b865540abd9d13f93c7cc7542eb0936355` aponta para o
manifest digest
`sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659`
e config digest
`sha256:696d37b59113ad6bc45247c1b9381b2238a322eb365f82ad6c2c9135456765d9`.
Não houve alteração de visibilidade, ruleset, infraestrutura ou deploy. A
correção concluiu a Gate 3 e a `0.8-MVP-04`.

## 0.8-MVP-04-CORR-02 — Publicação GHCR condicionada ao impacto real

**Concluída e incorporada pelo PR #34 no squash
`876aa4ae5a7f88bfbfd65ff4e40e3dab33c4079b`.**

Todo Pull Request, push da `main` e execução manual continua recebendo a
validação completa aplicável. Em push da `main`, o
job read-only `image-impact` compara os commits completos `before` e `head` por
Git sem shell e emite somente `should_publish=true|false`. O publicador depende
do sucesso de `validate` e `image-impact` e da saída canônica `true`; falha de
SHA, range, path ou parsing bloqueia o workflow e não permite publicação.

A allowlist mínima contém `Dockerfile`, `.dockerignore`, `.npmrc` quando
rastreado, `package.json`, `package-lock.json`, `nest-cli.json`, os
`tsconfig*.json` legítimos na raiz e `src/**`, incluindo as migrations atuais.
Documentação, runbooks, Compose, CI, scripts, testes, schemas, `.agents`,
`.codex` e `docker/postgres/**` não alteram a imagem sob o Dockerfile vigente.
A lista precisa ser atualizada junto com qualquer nova entrada do build ou do
runtime final.

O delta modificou somente workflow, detector, validator, testes e documentação.
O push não impactante da `main` retornou `false` e deixou `publish-image`
intencionalmente skipped antes de login ou build. Nenhuma imagem, tag, package,
credencial, infraestrutura, VPS ou deploy foi alterado.

## 0.8-MVP-05A — Contrato versionado de PostgreSQL, secrets e bundle

**Concluída e incorporada em 9 de agosto de 2026.** O PR #35 entrou na `main`
no squash `5268706d22cb69df7d065928c16b4425a03b41cf`. Separa
bootstrap/admin, migration owner e runtime; remove valores secretos do
environment do Compose; usa mounts seletivos e wrappers POSIX; fixa API e
PostgreSQL por digest `linux/amd64`; estabiliza projeto e volume externo;
adiciona grace period de 90 segundos ao banco e injeta o keyring de
idempotência de Leads somente na API.

A entrega também adiciona bundle mínimo determinístico com manifesto,
hashes, digests e timestamp reproduzível, além de validators, testes
adversariais e ADR-014. Ela preserva a imagem atual da API: nenhum path
image-affecting foi alterado. Durante a Gate 2, os bundles em modo `candidate`
foram somente evidência local não operacional. A incorporação não acessou a
VPS, não criou secret real ou volume persistente e não executou migration
remota ou deploy.

## 0.8-MVP-05A-CORR-01 — Alinhamento da matriz sintética da CI

**Concluída como parte do PR #35.**
A execução `31275744544`, job `93148867305`, no head
`d04d1600584bf7764b5ea204c459f5d529388c32`, revelou drift determinístico: o
workflow sintético anterior não fornecia `DATABASE_BOOTSTRAP_USER` ao contrato
da 05A. A correção audita a matriz completa, usa três roles válidas e distintas,
preserva os digests, o frontend e a versão do keyring de Leads e mantém secrets
sintéticos somente em arquivos privados sob `runner.temp`, sem log ou artifact
e com cleanup exato e fail-closed. A fase corretiva local não publicou imagem,
não acessou a VPS e não executou deploy.

## 0.8-MVP-05A-CORR-02 — Inicialização runtime dos paths da CI

**Concluída como parte do PR #35.** A CI rejeitou a expressão
`${{ runner.temp }}` no `jobs.validate.env`, pois esse contexto não está
disponível nessa posição estrutural. A correção removeu as cinco expressões do
nível do job e adicionou um step inicial que deriva os paths somente de
`RUNNER_TEMP`, em namespace fixo, exportando-os por `GITHUB_ENV` antes de todos
os consumidores. A matriz, os seis secrets, o cleanup `always()` exato e
fail-closed, permissões, pins, política de publicação e detector foram
preservados.

## 0.8-MVP-05A-CORR-03 — Fixtures Git herméticas do bundle

**Concluída como parte do PR #35.** Os testes candidate-mode dependiam do
manifesto ignorado do checkout do desenvolvedor e falhavam com `ENOENT` em um
checkout limpo da CI. A correção, restrita ao teste do bundle, criou uma fixture
Git temporária e independente por caso, com identidade local, base determinística,
manifesto/Task Packet próprios e ignorados, alteração candidata controlada,
fingerprint real e cleanup garantido. Nenhum mock de Git, fingerprint ou
validator foi introduzido; os contratos candidate e committed-release foram
preservados.

## 0.8-MVP-05A — Encerramento pós-merge

**Concluído em 2026-08-09.** O PR #35 foi incorporado em
`2026-08-09T00:39:02Z` (`2026-08-08T21:39:02-03:00`) pelo squash
`5268706d22cb69df7d065928c16b4425a03b41cf`. A CI de push da `main`
`31286630732` passou. O contrato V2 está na `main`; o detector retornou
`shouldPublish=false`, o job `publish-image` permaneceu `skipped`, nenhuma tag
nova foi criada e o manifest digest da API
`sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659`
permaneceu inalterado.

O bundle pós-merge em modo `committed-release` foi construído e validado com
`sourceCommit` igual ao squash, exatamente seis arquivos, todos em mode `0644`,
e resultado PASS. Bundles pré-merge `candidate` permaneceram apenas evidência
não operacional, e nenhum bundle foi transferido à VPS.

Naquele encerramento, nenhuma instalação de Docker, layout ou grupo do host,
secret real, volume,
PostgreSQL, role, migration, API, serviço, porta, dado, persistência ou prova de
prontidão foi executada. Naquele momento, a `0.8-MVP-05B` permanecia futura e
exigia autorização operacional própria e comprovação explícita de todas as suas
precondições.

## 0.8-MVP-05B — Instalação controlada da baseline privada na VPS

**Concluída tecnicamente em 9 de agosto de 2026.** A operação usou a `main`
`38baf1e8898194b618cfee787a3bea753677eb93` e o release imutável
`38baf1e8898194b618cfee787a3bea753677eb93-0c2e6d0ad2943e802c955eb21cf7fa1283adca4267666cfb4902a20d0111f8e0`.
O manifesto `0c2e6d0ad2943e802c955eb21cf7fa1283adca4267666cfb4902a20d0111f8e0`
declara o contrato `0.8-MVP-05A.v2`, `operational=true`; `current` foi trocado
atomicamente para esse release e o release anterior permaneceu preservado.
O host recebeu a baseline aprovada de Docker, layout root-only e secrets
file-backed; o volume externo original `genesis-postgres-data`, PostgreSQL 17,
três roles separadas, dez migrations e a API foram instalados e validados. API
e PostgreSQL permaneceram privados, healthy e fixados por digest, sem portas
Docker publicadas.

A VPS comprovada é `srv1870064`, IP `147.79.82.44`, Ubuntu 24.04.4 LTS. Docker,
SSH, UFW, fail2ban, AppArmor e swap ficaram ativos e persistentes, sem unidade
crítica falhada; somente TCP/22 permaneceu acessível externamente e TCP/80 e
TCP/443 ficaram fechadas. O PostgreSQL usa o índice por digest aprovado e a API
usa `ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659`,
ambos em `linux/amd64`.

A cadeia operacional foi executada por checkpoints com stop conditions e
verificação independente. No F-001, o mecanismo fictício de validação fechava o
PTY cedo demais e falhava ao comprovar a restauração do echo; nenhum secret real
foi processado nessas falhas. O driver corrigido manteve o PTY válido, a suíte
fictícia final passou `17/17`, a captura humana sem eco foi concluída pelo Web
Terminal e o finding foi reverificado como resolvido.

No F-002, as credenciais lógicas de migration e runtime permaneceram
inicialmente no environment do processo PostgreSQL porque o init `0644` é
sourced e seu trap de `EXIT` não roda antes do `exec` final. Nenhum valor ou
hash foi impresso, e logs, inspect, journal, argumentos e evidências tiveram
zero correspondências. O PostgreSQL foi contido graciosamente, com volume e
banco preservados; a correção remove as variáveis após o `psql`, mantém o trap
para erros e o desarma antes das consultas pós-init. Ela foi testada, verificada
e incorporada pelo PR #37. O release corrigido foi aplicado na VPS e o processo
final comprovou ausência das duas variáveis.

Os seis secrets foram capturados por fluxo humano sem eco, sem passagem pelo
chat ou pelas ferramentas. Cinco são valores simples e um é um keyring
versionado; na VPS, são exatamente seis arquivos regulares
`root:genesis-container-secrets` `0440`, fora de Git e evidências. A custódia usa
Bitwarden Free; o export JSON protegido por senha fica fora da VPS em
armazenamento offline cifrado, com senha separada e recovery code fora da
Bitwarden. Nenhum CSV ou JSON aberto foi produzido.

Migrations e API passaram por checkpoints próprios. A segunda execução das
migrations foi no-op; schema, owners, ACLs e privilégios runtime permaneceram
conformes, sem membership inesperado nem privilégio proibido de `PUBLIC`. A API
passou readiness `4/4`, hardening, mounts seletivos, bloqueio
de metadata e leak scan. Um único reboot autorizado comprovou recuperação
automática e persistência de host, containers, volume, dados, migrations,
secrets, firewall e readiness. A rede externa permaneceu restrita a TCP/22;
TCP/80, TCP/443 e TCP/3000 continuaram fechadas. O novo boot ID aprovado é
`1203958f-2ae3-448c-83c1-349b0bb952d8`; nenhum start manual mascarou a
recuperação, e bootstrap e migrations não foram repetidos.

## 0.8-MVP-05B — Verificação final e disposição do snapshot

**PASS técnico em 9 de agosto de 2026.** Um verifier distinto dos builders e
dos verificadores de checkpoint revisou os onze grupos finais em modo read-only,
com cobertura `11/11`, `implementedCandidate=false`, `writeOperations=0`,
`findings=[]`, `limitations=[]` e recomendação `approve`. A verificação ligou o
estado ao commit, release, manifesto, boot e fingerprints aprovados sem alterar
Git remoto, VPS, containers, banco, secrets ou firewall. O schema
`verifier-evidence.v1` e a validação semântica passaram.

Após o PASS, o Product Owner decidiu não restaurar e não excluir manualmente o
snapshot pré-05B, criado em 2026-08-09 às 09:10 BRT e preservado durante toda a
operação. O snapshot deve permanecer preservado até a expiração automática
indicada pela Hostinger em 2026-08-10; a expiração ainda não é declarada como
ocorrida. Essa disposição não autoriza ação adicional sobre o snapshot. A 05B
termina sem Traefik, HTTPS, proxy, exposição pública, backup/restore,
observabilidade ou dados reais; essas fronteiras dependem das tarefas e
autorizações posteriores.

Este registro encerra documentalmente a 05B quando incorporado, mas não declara
a VPS pronta para produção. PostgreSQL e API continuam operacionais somente nas
redes internas Docker; nenhuma etapa futura de exposição ou deploy público é
autorizada por este closeout.

## GH-01 / P-01 — Memória canônica e reconciliação cross-repo

**Candidato preparado para revisão humana.** A API passa a conter a autoridade
temporal estruturada `docs/memory/project-state.v1.json`; `CURRENT_STATE.md` é
gerado deterministicamente, e o Web integrado permanece pointer-only no commit
`fa4193fc28751d64923be824d293367499d4fba0`.

O piloto P-01 reconciliou os entrypoints estáveis da API, rotulou o roadmap como
snapshot histórico/superseded, corrigiu a afirmação obsoleta de que a 05B era
futura e adicionou freshness checks locais e cross-repo. Este registro não
declara a GH-01 concluída antes do merge futuro da API, não inicia trabalho
posterior e não autoriza Git remoto ou produção.

## Candidato 0.8-MVP-06A — Traefik, HTTPS e health-only edge

Em 10 de agosto de 2026 foi preparado localmente, sem stage, commit, push, PR
ou operação live, o candidato Critical da `0.8-MVP-06A` sobre a base
`67f10bb04d4e2af0c421b932067ef0bcb3d9e821`. O Gate 1 aprovou HTTP-01,
health-only e três modos explícitos de binding.

O candidato adiciona Traefik oficial `v3.7.9` por digest, file provider, base
sem portas, overrides internal/public-http/public-full, configurações ACME
separadas, router exclusivo de `GET /health`, trust proxy de um hop,
validators, testes e bundle ampliado. Produção, DNS, firewall, ACME live,
certificados, GHCR, Vercel, Web, usuários e dados reais não foram alterados.
HTTPS permanece não observado e a `0.8-MVP-06` não está concluída. O candidato
aguarda verificação independente e Gate 2.

## 0.8-MVP-07A — Recovery contract and tooling

Em 12 de agosto de 2026, a 07A preparou o contrato versionado, runners
fail-closed, configuração não secreta, units systemd, validators, testes
unitários/adversariais e integração sintética isolada. age 1.3.1 e rclone
1.74.4 usam fontes oficiais linux/amd64 e hashes públicos fixos.

O contrato fixa RPO 24h, frequência 12h, warning/critical 18/24h, RTO lógico
sintético 4h, retenção regular/checkpoint 30/90 dias, duas cópias verificadas e
Drive trash-only. O plano Window R nega volume ativo, portas, purge, reinícios e
candidate bundles. Produção, Drive, OAuth, chave definitiva, timers live, dados
reais e merge permaneceram sem mutação/autorização; operação real segue à 07B.

Na correção pré-Gate 3 A, dois findings humanos foram incorporados ao mesmo
envelope: provisionamento futuro idempotente e provenance-bound da role mínima
`genesis_backup`, e preflight não secreto que rejeita OAuth externo em `Testing`
ou status não comprovável. A execução da correção usa somente PostgreSQL 17
efêmero e dados sintéticos; produção, Drive e OAuth real continuam com zero
mutação. O candidate ID, CI e verificador anteriores foram invalidados.

O primeiro Gate 2 independente bloqueou três gaps High autônomos: fixtures Linux
sem ownership root, handoff de retenção dependente de modo executável e restore
sem convergência de ownership. A correção executa a suíte Linux/root sem skips e
mantém a rejeição de arquivos não-root, chama a retenção explicitamente por bash
mesmo no bundle 0644 e restaura/verifica database, schema, tabelas e sequências
sob `genesis_migration`. O novo candidato exige perfil Critical completo e nova
verificação independente antes de qualquer entrega Git.

## 0.8-MVP-07B — Window R3 rollback e correção do restore

Em 13 de agosto de 2026, a Window R3 revalidou o committed release em 27/27
artefatos, manteve `genesis_backup` conforme com zero mutações PostgreSQL e
preservou API, PostgreSQL e Traefik saudáveis com restart count zero. A
credencial OAuth externa `In production`, restrita a `drive.file`, foi aceita
sem exposição de segredo. A raiz app-owned foi criada e um único checkpoint
cifrado passou upload, download pela rota real e comparação SHA-256; o
plaintext temporário foi removido antes do transporte.

O restore Docker isolado publicou zero portas e não referenciou o volume ativo,
mas falhou de forma fail-closed no predicado agregado de ACL. A investigação
read-only mostrou ownership, migrations, schema e RLS conformes e isolou quatro
negações diretas de `SELECT` da role runtime que são intencionais em produção:
`migrations`, `lead_ingest_idempotency`, `lead_command_idempotency` e
`lead_follow_up_idempotency`. O runner incorporado exigia `SELECT` em todas as
tabelas e, portanto, uma segunda tentativa idêntica falharia
deterministicamente.

A decisão operacional foi `ROLLBACK`: marcador e ciphertext exatos foram
revalidados por path, object ID e SHA-256 e movidos somente para a lixeira; a
cópia cifrada local e os sete secrets sintéticos criados pela janela foram
removidos. Não houve purge permanente, restart produtivo, acesso ao volume
ativo, porta publicada ou ativação do timer. Role, identidade age sob custódia
dupla, ferramentas pinned e configuração OAuth root-only permaneceram
preservadas para uma futura janela autorizada.

A correção High ajusta o runner para exigir `SELECT` nas tabelas legíveis e
exigir a negação explícita nas quatro tabelas protegidas. O teste de contrato e
a integração sintética reproduzem a fronteira real; checks focados e integração
Docker passaram localmente. O candidato ainda não é release operacional: deve
passar validação Critical, verifier independente e CI Linux, ser incorporado à
`main`, gerar novo committed release e receber nova autorização Window antes de
qualquer repetição de checkpoint, restore ou timer. `RG-RECOVERY` permanece
pendente e dados reais continuam não autorizados.

## 0.8-MVP-07B — Window R4 concluída

Em 13 de agosto de 2026, a Window R4 instalou atomicamente o novo
`committed-release` de 28 arquivos vinculado ao squash
`06f469f91e3ce01893678b511f80880501e6a44d`, com manifesto
`2424a2f7fd9fb1674360ef3c59714bab30e04090fe9beec2950039839c59c103`. O
release anterior foi preservado para rollback e nenhum serviço de produção foi
reiniciado.

A evidência OAuth não secreta confirmou a conta dedicada
`admreserva433@gmail.com`, aplicação externa `In production` e escopo único
`drive.file`; a validação da credencial foi somente leitura e não iniciou novo
OAuth. `genesis_backup` permaneceu conforme com zero mutações PostgreSQL. Um
checkpoint novo foi cifrado antes do transporte, enviado com nome imutável,
baixado pela rota real e validado por SHA-256.

O restore corrigido passou em PostgreSQL 17 isolado em 17 segundos. A prova
confirmou ownership e RLS, `SELECT` runtime nas tabelas ordinárias, negação em
`migrations` e nos três ledgers de idempotência, API efêmera live/ready, zero
portas publicadas e nenhuma referência ao volume ativo. Todos os containers,
rede, volume e secrets sintéticos da execução foram removidos por procedência.

O timer foi habilitado sem restart e seu primeiro disparo real produziu um
backup regular verificado. O closeout comprovou duas cópias remotas válidas —
checkpoint e regular —, quatro objetos vivos vinculados por path, object ID e
marcador, e preservou os objetos da R3 na lixeira sem untrash ou purge. API,
PostgreSQL e Traefik terminaram saudáveis com restart count zero. A retenção
permanece trash-only, `RG-RECOVERY` passou e dados reais continuam dependentes
dos gates restantes e de autorização humana específica.

## 0.8-MVP-08 — Candidato API/Web para Gate de merge

Em 13 de agosto de 2026, Gate 1 autorizou somente o candidato local e a CI não
produtiva. A API candidata mantém o Compose base health-only, fixa a origem Web
única, adiciona um override funcional opt-in, renderização da chave apenas em
tmpfs e proveniência canônica do IP para rate limits/auditoria. Nenhum secret,
router live, VPS, DNS, Vercel, dado real ou migration foi criado ou alterado.

O contrato detalhado está no ADR-017. O resultado de verificação, os SHAs dos
commits/PRs e a recomendação de merge pertencem ao checkpoint VERIFY e não são
antecipados por este registro de candidato.

## 0.8-MVP-08B — Auditoria de integridade e contrato R2

Em 14 de agosto de 2026, a auditoria estritamente read-only reproduziu duas
cópias byte-idênticas do committed release R1 e confirmou seu fingerprint
`280a8ddd56cc0670cc58ff9dddae1e712c33c9fb7cacca8f8f217cebdbf02b51`.
Na VPS, os onze diretórios da árvore de release estavam `root:root 0777`; dois
arquivos do bundle corrente não estavam presentes e oito hashes divergiam. Não
foram encontrados symlink, hardlink, ACL, mount boundary, tipo especial ou
entrada inesperada. A árvore foi classificada `UNPROVEN`: o estado observado é
compatível com o release R4 anterior, mas parents graváveis impedem prova
retroativa de integridade. Nenhuma mutação remota foi executada.

A R2 versionou o contrato completo da árvore no manifesto do bundle. Os onze
diretórios ativos são `root:root 0755`; staging começa `0700`; rollback vem
somente de um committed release v2 derivado para a imagem `previous-approved`; a árvore antiga é
quarentenada `0700` e marcada `UNTRUSTED`. A ativação e o rollback usam apenas
`renameat2(RENAME_EXCHANGE)` no mesmo filesystem, sem fallback por `mv`.
Secrets, recovery state, ACME, volumes, PostgreSQL e destinos remotos ficam fora
de toda travessia e troca.

A matriz Linux descartável cobriu metadata, conteúdo, ACL, links, tipo
especial, lock concorrente, staging incompleto, falhas antes e depois da troca,
rollback, quarentena, ausência da primitiva e preservação de estado externo.
Ela não acessou a VPS nem executou backup, Compose, migration ou restart. O
contrato incorporado ainda não corrige a árvore remota: atomic rebuild,
HD-08B-02, 2FA/recuperação e Operational Gate continuam separados.

Na primeira revisão Critical, o verificador independente bloqueou um finding
High: o manager exigia bundle rollback v2, mas o builder só emitia a imagem
corrente e o teste Python fabricava o manifesto rollback. A correção tornou o
papel `current|rollback` explícito em builder, validator e manager. O rollback
real agora é gerado do mesmo containing commit por uma derivação fechada que
substitui exatamente duas referências de imagem no Compose, registra a
proveniência no manifesto e exige imagem/fingerprint distintos e relação
`previous-approved`. Um teste ponta a ponta entrega o artefato real do builder
ao validator e, em Linux, ao manager; o candidato e seus fingerprints anteriores
foram invalidados. A comparação do par também exige o mesmo `sourceCommit` e
igualdade integral dos demais artefatos; drift não-Compose é rejeitado mesmo
quando o manifesto divergente se auto-recalcula de forma consistente.

## 0.8-MVP-09A — Fixture sintética reversível

Em 15 de agosto de 2026, o PR #54 incorporou no commit
`442cbd297cdd7166af091f56e892850029b4ad47` um CLI privado e transacional para
criar, consultar e desativar uma fixture sintética identificada por manifesto.
O mecanismo usa escopo explícito, evita hard delete e não adiciona rota pública
ou migration. A execução real permaneceu condicionada a autorização posterior.

## 0.8-MVP-09C/09D — Controle manual e publicação da imagem

O PR #55 (`0a56a8aee7c64bda59a1981888418e1ad03950c0`) separou CI de publicação e passou
a exigir dispatch manual, SHA completo e aprovação do Environment. Os PRs
#56–#59 endureceram o lookup do tag e o vínculo do workflow; a publicação final
única foi o run `32401997540` e produziu
`sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb`.
Manifesto e pacote sanitizados possuem, respectivamente, SHA-256
`b492851312b3fb5e51542c4757b4da9835d9cf124c2f1ef21bd04c1dec2f580a` e
`5c26b43099f44aa04ef22e5edd7ddf689d5967feb2eb4286fd6761bbb01fec43`.

## 0.8-MVP-09E — Deployment observado da API

Em 21 de agosto de 2026, a imagem `b45425d7…` foi promovida com KEEP e
`a4dafefa…` foi preservada como rollback. API, PostgreSQL e Traefik terminaram
saudáveis; nenhuma migration foi executada. O resultado foi
`TASK_09E_DEPLOYED_AND_OBSERVED`.

O script executado possui SHA-256
`e99dee6fb4610f9ca470aca8e12f00c4076e60ea45de3f9fb7a4f762208b6db6`; o
manifesto e o pacote possuem SHA-256
`035ce98be31cd870162104748bf1178e7c1bdc4ccf18603ed52494751f41bb33` e
`2cbc48f6454e20ee0042aeda194c250d90665952b2458ac896075174201cc683`.
O artefato exato está em custódia operacional externa, não está
comprovadamente versionado na `main` e não deve ser reconstruído a partir da
branch local 09E. Um futuro deployment exige reconciliar e versionar novamente
o procedimento.

## 0.8-MVP-09F–09I — Ativação, usabilidade, desativação e closure

A fixture foi ativada de forma controlada, usada em uma sessão de usabilidade
com dados exclusivamente sintéticos e reconciliada antes da desativação. A 09H
encerrou em `DEACTIVATED`, com zero Leads, Sessions e Refresh Tokens sintéticos
ativos, sem hard delete, migration ou alteração de dado real. O manifesto final
e o pacote possuem SHA-256
`2504986f63a348fd560843173fbb6d0935d55a24a31de5e5c42739426c977680` e
`dbc8185512793d8fbaa192612ee8488157f8495f77e5ae7862faebb6ef941ae5`.

A 09I encerrou com
`TASK_09I_CLOSED_MVP_LIVE_WITH_USABILITY_GAPS` e veredito
`MVP_LIVE_VALIDATED_WITH_USABILITY_GAPS`. Manifesto e pacote possuem SHA-256
`b0e7f78b13f0283dfe1005883a22527f31d4e0aed44c036d71229403a3d56c26` e
`9edb9b350db89f1c1ba8e06eaff9df1a28ea38bed8679d253c84ef5f85f95fe5`.
Os três gaps observados foram resolvidos posteriormente pela 10B no Web.

## 0.8-MVP-10A — Onboarding privado de OWNER

Em 21 de agosto de 2026, o PR #61 incorporou no squash
`f5a11c6ad5b6f4817198730b8311d27117ee01a7` o CLI privado
`npm run operator:owner -- create/status`. Ele exige TTY, senha mascarada,
autorização literal, role operacional atestada, prevenção de conflito e
transação `SERIALIZABLE`; não adiciona endpoint, migration, Lead, Session ou
Refresh Token.

Uma operação humana autorizada criou a organização Porto e exatamente um OWNER
real ativo; o status e o login humano passaram. Nenhuma PII, credencial, cookie
ou token é preservado neste histórico. O resultado foi
`TASK_10A_PRODUCTION_OWNER_ONBOARDED`; manifesto e pacote sanitizados possuem
SHA-256 `48804774393a6eceeb454b57219e00b3ec75d37911c05030f9a622f60912d725` e
`232455043b866a14ff45c463db2e484a6c413a7e23ed2b394450ca2283995192`.

## If-Match Transport Shim V2 — integração e observação em produção

Em 25 de agosto de 2026, o PR Web #20 foi integrado por squash em
`017ef0056d97147a5e5337494fa339a3f65986ac`, árvore
`5756fda028b91593473d8fe06238485dc24f7938`; a CI pós-merge 32870003911 e o
check Validate frontend passaram. O browser passou a usar
`X-Genesis-If-Match`, e os proxies Vercel/Vite validam esse valor de forma
fail-closed e materializam `If-Match` somente no hop upstream. API, banco e
semântica de concorrência otimista permaneceram inalterados.

A investigação do falso 412 observou um único PATCH: o browser recebeu 412,
Traefik/API registraram 200, não houve retry nem segundo writer, e o banco
confirmou a mutação com revisão 18→19. O probe independente preservado na
branch `codex/vercel-if-match-probe`, commit
`45001ad805c110b1bff4fbf3a0ba8a90fc67dd05` e deployment
`dpl_CrSiMzQBJD5ypbxNpKrkdh4MWqPk` reproduziu a transformação externa para 412
com `If-Match` divergente. A evidência limita a conclusão à fronteira Vercel;
não identifica o componente interno nem declara correção do provedor. O support
packet permaneceu pronto e não enviado.

O deployment `dpl_J6SwpHNDGHL9MUdXLZeNVb1wfwyr`, fonte `017ef005…`, foi
promovido em `2026-08-25T16:43:46.645Z` e ficou Ready, Production e Current no
hostname aprovado; `dpl_9Npu4VnyWatw1vMEforzUv8Mokke` ficou preservado para
rollback. Root, login, assets, health, cache e logs passaram no smoke técnico.
O canary sem sessão chegou à fronteira auth/API com 401 esperado, sem
`PRECONDITION_FAILED` e sem mutação. O smoke manual autenticado confirmou na
primeira tentativa a edição condicional de Interesse e também as operações de
nota, próxima ação e mudança de etapa, sem falso 412; refresh confirmou a nova
revisão e o valor persistido. O Weak ETag e o falso 412 ficaram resolvidos e
observados em produção. Nenhum cleanup remoto ou envio a suporte fez parte do
closeout.
