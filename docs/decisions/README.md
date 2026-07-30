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
- [ADR-005 — Autorização por papel](ADR-005-role-based-authorization.md) — Accepted; implementado na tarefa 0.2.4
- [ADR-006 — Modelo operacional multiagente](ADR-006-multi-agent-operating-model.md) — Accepted; implementado na tarefa 0.2.2.4
- [ADR-007 — Convites, memberships e invariantes de ownership](ADR-007-invitations-memberships-ownership.md) — Accepted; implementação iniciada na tarefa 0.2.5.1
- [ADR-008 — Lifecycle comercial de Leads por estado atual e ciclos imutáveis](ADR-008-lead-commercial-lifecycle.md) — Accepted; implementado na tarefa 0.3.2
- [ADR-009 — Activities, Notes e Next Action tipadas](ADR-009-lead-activities-follow-up.md) — Accepted; implementado na tarefa 0.3.3
- [ADR-010 — Contrato web de sessão e bootstrap](ADR-010-web-session-contract.md) — Accepted; incorporado na tarefa 0.7.0 pelo PR #22, squash `9f0fb751f6e506ade1d0e0af0f7f80506b4a93f2`
- [ADR-011 — Arquitetura da primeira produção](ADR-011-production-architecture.md) — Accepted em 30 de julho de 2026; ainda não implementado
