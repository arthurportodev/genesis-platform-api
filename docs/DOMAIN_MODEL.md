# Modelo de domínio atual

Este documento resume conceitos implementados; as migrations são a fonte do schema exato.

## User

- **Propósito:** representar uma pessoa globalmente, independentemente de organização.
- **Identidade:** UUID gerado pelo PostgreSQL.
- **Campos principais:** email, nome, status, hash/data de alteração da senha e timestamps.
- **Relações:** possui memberships e sessões de autenticação.
- **Status:** `active` ou `inactive`.
- **Constraints:** email globalmente único, normalizado; nome não vazio e sem bordas.
- **Sensível:** `password_hash`, excluído da serialização e da seleção padrão.
- **Escopo:** global; não contém `organization_id` nem papel.

## Organization

- **Propósito:** representar uma empresa/tenant.
- **Identidade:** UUID gerado pelo PostgreSQL.
- **Campos principais:** nome, slug, status e timestamps.
- **Relações:** possui memberships.
- **Status:** `active` ou `inactive`.
- **Constraints:** slug globalmente único em formato minúsculo adequado para URL; nome válido.
- **Escopo:** raiz do tenant, selecionada por request pela infraestrutura implementada.

## Membership

- **Propósito:** vincular `User` e `Organization`.
- **Identidade:** UUID gerado pelo PostgreSQL.
- **Campos principais:** `user_id`, `organization_id`, papel, status e timestamps.
- **Relações:** pertence obrigatoriamente a um user e uma organization.
- **Papéis:** `owner`, `admin`, `member`.
- **Status:** `active` ou `inactive`.
- **Constraints:** par user/organization único; foreign keys usam `ON DELETE RESTRICT`.
- **Ownership:** o papel pertence à membership, nunca diretamente ao user.

## AuthSession

- **Propósito:** controlar uma sessão autenticada e permitir revogação imediata.
- **Identidade:** UUID, também referenciado no access token e no prefixo do refresh token.
- **Campos principais:** user, status, expiração, último uso, revogação/motivo, IP, user agent e timestamps.
- **Relações:** pertence a um user e possui histórico de refresh tokens.
- **Status:** `active` ou `revoked`.
- **Constraints:** estado e `revoked_at` devem ser coerentes; user usa `ON DELETE RESTRICT`.
- **Escopo:** pertence ao user, não a uma organização.

## AuthRefreshToken

- **Propósito:** registrar cada token de uma família e sua rotação.
- **Identidade:** UUID; o token bruto não é persistido.
- **Campos principais:** sessão, HMAC do token, status, validade, consumo, revogação e substituto.
- **Relações:** pertence a uma sessão e pode apontar para o token substituto.
- **Status:** `active`, `consumed` ou `revoked`.
- **Constraints:** hash hexadecimal único de 64 caracteres, estado temporal coerente e substituto único.
- **Sensível:** `token_hash`, excluído da serialização e da seleção padrão.

## AuthAuditLog

- **Propósito:** manter trilha persistente de eventos de autenticação.
- **Identidade:** UUID.
- **Campos principais:** user/sessão opcionais, tipo de evento, IP, user agent, metadata sanitizada e criação.
- **Eventos:** login/refresh bem-sucedidos ou falhos, reutilização, logout e logout-all.
- **Relações:** referências opcionais usam `ON DELETE SET NULL` no schema.
- **Sensível:** metadata é sanitizada e excluída da serialização padrão.

## TenantContext

- **Propósito:** representar, durante uma única request, o acesso validado do user a uma organização ativa.
- **Natureza:** conceito implementado e tipado de request; não é entidade, tabela ou estado persistido.
- **Campos:** `userId`, `organizationId`, `membershipId` e `role`.
- **Origem:** user autenticado, header UUID v4 validado e membership atual consultada no PostgreSQL.
- **Ciclo de vida:** criado pelo `TenantContextGuard` para cada request tenant-scoped e acessado por `CurrentTenant`.
- **Autorização:** o `RoleGuard` implementado consome `role` exclusivamente deste contexto e compara com listas explícitas declaradas por `@Roles`, sem consultar o banco novamente ou modificar o contexto.
- **Limite:** não é armazenado em JWT, sessão ou user; não representa permissions, hierarquia de papéis ou autorização por recurso.

## OrganizationInvitation

- **Propósito:** representar um convite tenant-scoped para `member` ou `admin`.
- **Estados persistidos:** `pending`, `accepted`, `revoked`; `expired` é derivado
  de `expires_at` com precedência accepted → revoked → expired → pending.
- **Token:** nonce não selecionado por padrão e versões são persistidos; token,
  MAC e hash não são persistidos. A MAC HMAC-SHA-256 é regenerável por keyring.
- **Lifecycle:** a 0.2.5.1 implementou create, revoke idempotente e replace com
  nova linha e relação imutável; a 0.2.5.2 implementou aceitação autenticada
  para usuário existente e a 0.2.5.3 adiciona activation para usuário inexistente.
- **Emissor:** membership imutável. Inativar issuer membership/user revoga
  pendentes na mesma transação; mudar role não revoga.

## InvitationDeliveryOutbox e OrganizationAuditLog

O outbox contém somente colunas explícitas e referências, sem token/email/link;
a 0.2.5.2 adicionou worker, retry, fencing e dead-letter sobre os
estados persistidos. A auditoria organizacional é append-only no PostgreSQL e
não reutiliza `AuthAuditLog`.

## Acceptance 0.2.5.2

Uma invitation pending e não expirada pode ser inspecionada pelo bearer e
aceita somente pelo usuário autenticado de email correspondente. O resultado é
atômico: invitation `accepted`, membership criada/preservada/reativada, outbox
cancelável cancelada e um audit append-only. Replay do mesmo usuário devolve os
mesmos IDs sem novos efeitos; membership ativa com papel divergente é conflito.

## Activation 0.2.5.3

Uma invitation pending, não expirada e sem User global para o email pode criar
um User ativo, credencial Argon2id e Membership ativa. Email, Organization e
papel são derivados somente da invitation; `owner` é impossível. O mesmo
timestamp transacional confirma email e mudança de senha. User existente ou uma
corrida na unicidade global não é alterado: toda a activation reverte e o fluxo
autenticado de acceptance continua separado.

## Regra para entidades futuras

Entidades de negócio tenant-scoped devem conter `organization_id` e depender do contexto validado. `OrganizationInvitation` e suas rotas administrativas são a primeira aplicação dessa regra; uma matriz geral de capacidades e as demais entidades de negócio ainda não existem.
