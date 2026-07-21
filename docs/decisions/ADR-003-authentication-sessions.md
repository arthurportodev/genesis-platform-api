# ADR-003 — Autenticação e sessões

- **Status:** Accepted
- **Data:** 2026-07-19 (registro retrospectivo da decisão implementada no PR #2)

## Contexto

A plataforma precisa autenticar usuários, revogar acesso imediatamente e detectar reutilização real de refresh token sem antecipar o contexto de organização.

## Decisão

- Armazenar senhas com Argon2id.
- Emitir access JWT HS256 de curta duração com user e session, sem tenant ou papel.
- Persistir sessões e validar seu estado no banco a cada request protegida.
- Emitir refresh token opaco; persistir somente HMAC-SHA-256 com pepper.
- Manter um registro por refresh token e rotacioná-lo em transação.
- Fazer uma pré-leitura mínima, sem decisão, e serializar refresh na ordem
  `User` -> `AuthSession` -> `AuthRefreshToken`; reler e validar todo o estado
  somente depois dos locks.
- Manter `users` sem `UPDATE` para a role runtime. O lock do user usa somente
  `app_private.lock_auth_refresh_user(uuid)` com `FOR NO KEY UPDATE`, força que
  preserva a exclusão mútua com inativação/delete/mudança de chave sem bloquear
  o `KEY SHARE` das foreign keys de auditoria.
- Tratar reapresentação de token consumido como replay comprovado e revogar a família.
- Não revogar uma sessão quando apenas um segredo desconhecido é apresentado.
- Preservar sessões e auditoria após logout para rastreabilidade.

## Alternativas consideradas

- **JWT completamente stateless:** rejeitado por não permitir revogação imediata de sessão.
- **Refresh token bruto no banco:** rejeitado porque vazamento do banco permitiria uso direto.
- **Um único hash sobrescrito por sessão:** rejeitado porque impediria comprovar reutilização de tokens anteriores.
- **Organização no JWT:** rejeitada para manter autenticação independente da organização ativa e evitar claims obsoletas.

## Consequências

- Requests autenticadas fazem consulta adicional ao PostgreSQL.
- Revogação, logout e bloqueio de user têm efeito imediato.
- Histórico aumenta volume e exige futura política de retenção.
- Rotação e locking aumentam complexidade, mas distinguem replay real de entrada aleatória.
- Refresh, logout e logout-all podem progredir concorrentemente sem o ciclo
  causado por `FOR UPDATE` no user; refresh e inativação global continuam
  serializados pelo mesmo row lock.
- A estratégia de entrega do refresh token ao frontend ainda precisa ser definida.

## Relações

- [Segurança](../SECURITY.md)
- [ADR-004 — Contexto de organização ativa](ADR-004-active-organization-context.md)
- Migration [`1784486400000`](../../src/database/migrations/1784486400000-CreateAuthSessions.ts)

## Implementação

Implementado no `AuthModule`, `AuthSessionsModule`, guard, serviços, entidades e
testes da tarefa 0.2.2. A Tarefa 0.2.5.1 acrescentou a fronteira
least-privilege de lock do user e testes PostgreSQL reais de ACL, força do lock,
concorrência, reuse e rollback, sem alterar a API pública.
