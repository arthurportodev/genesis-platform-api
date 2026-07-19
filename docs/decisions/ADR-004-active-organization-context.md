# ADR-004 — Contexto de organização ativa

- **Status:** Accepted — implementation pending task 0.2.3
- **Data:** 2026-07-19

## Contexto

Um user pode participar de várias organizações. Requests de negócio precisarão selecionar um tenant sem acoplar a autenticação a uma organização fixa ou carregar papel potencialmente obsoleto no JWT.

## Decisão

- O frontend enviará `X-Organization-Id` em requests tenant-scoped.
- O JWT continuará sem organização ativa.
- O backend validará que a organização está ativa.
- O backend validará uma membership ativa do user autenticado na organização.
- O backend criará contexto tipado com `userId`, `organizationId`, `membershipId` e `role`.
- Requests tenant-scoped dependerão desse contexto validado.
- Autorização por papel será implementada na tarefa 0.2.4.
- Invariantes como proteção do último owner serão tratadas em tarefa posterior.

## Alternativas consideradas

- **Organização ativa no JWT:** rejeitada porque troca de organização exigiria novo token e claims de membership poderiam ficar obsoletas.
- **Confiar apenas no identificador enviado:** rejeitada; toda request deve validar organização e membership no backend.

## Consequências

- O mesmo access token poderá operar em organizações diferentes nas quais o user tenha membership ativa.
- A validação adicionará consulta/cache controlado antes da lógica tenant-scoped.
- Serviços de negócio deverão receber contexto tipado e filtrar por `organization_id`.
- Header ausente, organização inválida ou membership inválida deverão falhar sem revelar dados de outro tenant; contrato HTTP exato pertence à implementação.

## Relações

- [ADR-002 — Estratégia multi-tenant](ADR-002-multi-tenant-strategy.md)
- [ADR-003 — Autenticação e sessões](ADR-003-authentication-sessions.md)
- [Roadmap](../ROADMAP.md)

## Implementação

**Não implementado.** Não existem hoje header parser, tenant guard, contexto tipado de organização, decorators ou endpoints tenant-scoped. Este ADR orienta a tarefa 0.2.3 e não prova a existência desses componentes.
