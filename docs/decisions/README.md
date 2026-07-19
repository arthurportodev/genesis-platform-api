# Architecture Decision Records

ADRs registram decisões arquiteturais relevantes, seu contexto, alternativas e consequências. Eles explicam por que o sistema tomou uma direção; não substituem código, migrations ou documentação operacional.

## Status

- **Proposed:** em discussão, sem aprovação.
- **Accepted:** decisão vigente.
- **Deprecated:** ainda documentada, mas não recomendada.
- **Superseded:** substituída por outro ADR, que deve ser relacionado.
- **Rejected:** considerada e recusada.

Um ADR aceito não deve ser reescrito para esconder a história. Correções factuais pequenas podem ser identificadas; mudança de decisão exige novo ADR e o anterior passa a `Superseded`.

## Quando criar

Crie ADR quando a decisão afetar múltiplas tarefas, segurança, dados, isolamento, operação ou uma restrição difícil de reverter. Detalhes locais e temporários não precisam de ADR.

## Formato

```text
# ADR-XXX — Título

- Status
- Data
- Contexto
- Decisão
- Alternativas consideradas
- Consequências
- Relações
- Implementação
```

## Índice

- [ADR-001 — Monólito modular](ADR-001-modular-monolith.md) — Accepted
- [ADR-002 — Estratégia multi-tenant](ADR-002-multi-tenant-strategy.md) — Accepted
- [ADR-003 — Autenticação e sessões](ADR-003-authentication-sessions.md) — Accepted
- [ADR-004 — Contexto de organização ativa](ADR-004-active-organization-context.md) — Accepted; implementado na tarefa 0.2.3
