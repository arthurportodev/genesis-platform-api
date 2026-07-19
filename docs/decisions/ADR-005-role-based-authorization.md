# ADR-005 — Autorização por papel

- **Status:** Accepted — implementation in progress (task 0.2.4)
- **Data:** 2026-07-19

## Contexto

O contexto de organização ativa identifica uma membership válida e inclui seu papel persistido. Rotas tenant-scoped futuras precisam declarar quais papéis podem executar cada ação sem acoplar autenticação, seleção de tenant e autorização, nem carregar claims potencialmente obsoletas no token.

Ainda não existem endpoints de negócio ou matriz real de capacidades. A infraestrutura deve ser explícita e segura sem antecipar permissions, policies ou regras de recursos.

## Decisão

- Manter autorização separada de autenticação e de tenant context em um `AuthorizationModule`.
- Compor a cadeia `AccessTokenGuard` → `TenantContextGuard` → `RoleGuard` → controller.
- Obter o papel exclusivamente da membership persistida, já exposta em `TenantContext.role`.
- Fazer o `RoleGuard` consumir somente `Reflector` e a request, sem consulta adicional ao banco ou cache.
- Declarar papéis permitidos por listas explícitas e tipadas com `@Roles(MembershipRole...)`.
- Não inferir hierarquia, herança ou ordenação entre `owner`, `admin` e `member`.
- Permitir metadata em controller e handler; metadata do handler substitui a do controller.
- Tratar metadata ausente, vazia ou malformada como `500 Authorization configuration is invalid.`.
- Tratar tenant context ausente como `500 Tenant context is unavailable.`, pois indica composição incorreta da cadeia.
- Negar papel não listado com `403 Organization access denied.`, sem revelar papel atual, lista permitida, organization, membership ou política.
- Adiar a matriz real de acesso até existirem endpoints de negócio.

## Alternativas consideradas

- **RoleGuard no TenantContextModule:** rejeitado por misturar resolução do contexto com decisão de autorização.
- **Hierarquia implícita:** rejeitada porque não existe matriz aprovada e poderia conceder privilégios não intencionais.
- **Papel no JWT ou sessão:** rejeitado por obsolescência e por contrariar a separação já aceita nos ADR-003 e ADR-004.
- **Nova consulta no RoleGuard:** rejeitada por duplicar a leitura já feita pelo tenant context.
- **Permissions, policy engine ou autorização por recurso:** adiados até surgirem requisitos concretos.
- **Permitir rota sem metadata:** rejeitado porque um erro de configuração abriria acesso silenciosamente.

## Consequências

- Cada rota deverá listar todos os papéis aceitos, tornando a política local e auditável.
- Mudanças de papel no PostgreSQL serão observadas na próxima request tenant-scoped sem novo token.
- O guard não adicionará query ao fluxo existente.
- `@Roles` sem `RoleGuard` não protege por si só; módulos consumidores deverão compor os três guards e testar a configuração.
- Uma alteração concorrente de papel depois da resolução do contexto afeta somente a request seguinte; operações futuras de alto risco poderão exigir revalidação transacional própria.
- Proteção do último owner, transferência de ownership, gestão de membros e regras comerciais permanecem fora do escopo.

## Relações

- [ADR-002 — Estratégia multi-tenant](ADR-002-multi-tenant-strategy.md)
- [ADR-003 — Autenticação e sessões](ADR-003-authentication-sessions.md)
- [ADR-004 — Contexto de organização ativa](ADR-004-active-organization-context.md)
- [Roadmap](../ROADMAP.md)

## Implementação

**Em andamento na tarefa 0.2.4.**

A branch contém `AuthorizationModule`, `@Roles`, `RoleGuard` e testes unitários/E2E com controller exclusivo de teste. Não há consumidor tenant-scoped de produção, permissions, hierarquia, policy engine, migration, dependência ou acesso adicional ao banco. Este ADR não declara a tarefa concluída antes de revisão e merge.
