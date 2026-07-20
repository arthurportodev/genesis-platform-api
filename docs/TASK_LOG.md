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
- Nenhuma funcionalidade da API foi alterada, e a Tarefa 0.2.5 continua planejada e não iniciada.

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
- Próxima tarefa funcional planejada: 0.2.5 — Convites e gestão de membros; ainda não iniciada.
