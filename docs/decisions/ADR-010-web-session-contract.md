# ADR-010 — Contrato web de sessão e bootstrap

- **Status:** Accepted
- **Data:** 2026-07-28

## Contexto

O contrato original entregava access e refresh tokens em JSON e recebia o
refresh token no body. Isso era suficiente para clientes controlados, mas
exporia ao JavaScript do frontend futuro uma credencial longa e reutilizável.
O navegador também precisa descobrir as Organizations disponíveis sem fixar
tenant, membership ou papel no JWT.

## Decisão

- O access token continua sendo um JWT curto, tenant-agnostic, retornado em
  JSON e mantido somente em memória pelo frontend futuro. Ele contém apenas
  user, sessão, tipo e claims temporais e continua validado no PostgreSQL.
- O refresh token opaco trafega exclusivamente em cookie `HttpOnly`, host-only,
  `SameSite=Lax` e `Path=/`. Produção usa `__Host-genesis_refresh` com `Secure`;
  desenvolvimento e teste usam nome separado sem `Secure`.
- Login, refresh, logout e logout-all exigem double submit: cookie CSRF
  legível pelo frontend e `X-CSRF-Token`, comparados de modo resistente a
  timing. Quando `Origin` está presente, ele deve coincidir com a origem exata
  configurada.
- `GET /auth/csrf` emite material aleatório sem criar sessão. Login define o
  refresh cookie, refresh o substitui, e logout/logout-all removem refresh e
  CSRF. O refresh nunca é aceito por body, query ou header alternativo.
- Logout da sessão atual não depende de access token e responde `204` de modo
  idempotente mesmo sem refresh identificável. Logout-all continua exigindo
  Bearer válido.
- `GET /auth/bootstrap` usa somente Bearer e retorna o user e as Organizations
  ativas ligadas por memberships ativas do próprio user. O papel vem da
  membership persistida, a ordem é determinística e a rota não exige
  `X-Organization-Id`.
- Respostas de autenticação, bootstrap e dados tenant-scoped usam `no-store`.
  CORS aceita uma única origem ambiental exata com credentials e allow/expose
  headers explícitos, sem wildcard.
- O frontend futuro deverá preferir proxy same-origin. `localStorage` e outros
  armazenamentos JavaScript não serão usados para access ou refresh tokens.

## Alternativas consideradas

- **Refresh em JSON ou canal legado simultâneo:** rejeitado porque mantém a
  credencial acessível a JavaScript e amplia a superfície de exfiltração.
- **Refresh em `localStorage`:** rejeitado porque XSS obtém uma credencial de
  longa duração diretamente.
- **Access token também em cookie:** rejeitado neste estágio; Bearer em memória
  preserva o contrato atual e separa autenticação explícita de cookies
  ambientes.
- **CSRF global para toda a API:** adiado; esta decisão limita double submit às
  operações de autenticação que usam cookies.
- **Tenant ou papel no JWT:** rejeitado porque ficaria obsoleto e acoplaria a
  sessão a uma Organization.
- **Grace period de refresh para múltiplas abas:** rejeitado porque enfraquece a
  detecção de reutilização comprovada.

## Consequências

- Clientes web precisam obter CSRF antes das quatro mutações de autenticação e
  enviar cookies com credentials.
- A rotação transacional, histórico HMAC-only e reuse detection permanecem
  inalterados. Reapresentar token consumido continua revogando a família.
- Refreshes concorrentes entre abas podem fazer uma aba comprovar reuse e
  revogar a sessão. O frontend futuro é responsável por coordenar refresh entre
  abas; o backend não oferece tolerância nem múltiplos sucessores válidos.
- O bootstrap adiciona leitura autenticada de memberships e Organizations, mas
  não seleciona tenant nem concede autorização.
- Um proxy same-origin futuro reduz dependência de CORS, sem alterar cookies,
  CSRF ou as invariantes do backend.

## Relações

- [ADR-003 — Autenticação e sessões](ADR-003-authentication-sessions.md)
- [ADR-004 — Contexto de organização ativa](ADR-004-active-organization-context.md)
- [Segurança](../SECURITY.md)

## Implementação

Implementado e incorporado pela Tarefa 0.7.0 no PR #22, squash
`9f0fb751f6e506ade1d0e0af0f7f80506b4a93f2`. Não exigiu migration, mudança de
schema ou dependência nova.
