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
- A estratégia de entrega do refresh token ao frontend ainda precisa ser definida.

## Relações

- [Segurança](../SECURITY.md)
- [ADR-004 — Contexto de organização ativa](ADR-004-active-organization-context.md)
- Migration [`1784486400000`](../../src/database/migrations/1784486400000-CreateAuthSessions.ts)

## Implementação

Implementado no `AuthModule`, `AuthSessionsModule`, guard, serviços, entidades, migration e testes da tarefa 0.2.2.
