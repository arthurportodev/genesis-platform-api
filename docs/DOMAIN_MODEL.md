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
- **Escopo:** raiz do tenant, mas ainda não existe organização ativa por request.

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

## Regra para entidades futuras

Entidades de negócio tenant-scoped deverão conter `organization_id` e depender do contexto validado. Essa regra é arquitetural; tais entidades e o contexto ainda não foram implementados.
