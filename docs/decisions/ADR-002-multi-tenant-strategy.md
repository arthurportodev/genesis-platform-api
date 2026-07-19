# ADR-002 — Estratégia multi-tenant

- **Status:** Accepted
- **Data:** 2026-07-19 (registro retrospectivo da decisão implementada no PR #1)

## Contexto

A plataforma deve servir várias empresas, permitir que uma pessoa participe de múltiplas organizações e manter custo operacional adequado ao estágio do produto.

## Decisão

Usar shared database/shared schema. `User` é global; `Organization` representa o tenant; `Membership` conecta ambos e armazena papel/status. Entidades de negócio futuras deverão conter `organization_id`.

O backend deverá aplicar isolamento em toda operação tenant-scoped. Defesa em profundidade no banco será avaliada conforme o modelo amadurecer.

## Alternativas consideradas

- **Banco por tenant:** rejeitado no estágio atual por provisionamento, migrations e operação mais complexos.
- **Schema por tenant:** rejeitado por multiplicar schemas e dificultar evolução uniforme.
- **PostgreSQL RLS imediato:** adiado; permanece possibilidade futura de defesa em profundidade, não proteção existente.

## Consequências

- Compartilhamento reduz custo e simplifica migrations.
- Consultas de negócio exigirão `organization_id` e testes explícitos de isolamento.
- Um erro de filtro pode atravessar tenants; contexto centralizado, autorização e possivelmente RLS devem reduzir esse risco.
- Usuários não precisam ser duplicados ao participar de organizações diferentes.

## Relações

- [ADR-004 — Contexto de organização ativa](ADR-004-active-organization-context.md)
- [Modelo de domínio](../DOMAIN_MODEL.md)
- Migration [`1784400000000`](../../src/database/migrations/1784400000000-CreateMultiTenantCore.ts)

## Implementação

Users, organizations e memberships estão implementados. `organization_id` em entidades de negócio e defesa tenant-scoped ainda dependem das próximas tarefas.
