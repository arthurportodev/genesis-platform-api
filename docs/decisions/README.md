# Architecture Decision Records

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

ADRs preservam decisões e história. Eles não são autoridade de fase, trabalho,
operação ou restrições atuais; esses fatos vêm de
`docs/memory/project-state.v1.json`.

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
- [ADR-011 — Arquitetura da primeira produção](ADR-011-production-architecture.md) — Superseded pelo ADR-013; preservado como histórico
- [ADR-012 — Development Operating System v2](ADR-012-development-operating-system-v2.md) — Accepted em 30 de julho de 2026; processo de desenvolvimento vigente
- [ADR-013 — Baseline mínima de produção do MVP](ADR-013-mvp-production-baseline.md) — Accepted em 3 de agosto de 2026; supersede o ADR-011 e define decisões duráveis de topologia, destinos e operação mínima sem declarar estado live
- [ADR-014 — Contrato versionado de PostgreSQL, secrets e bundle](ADR-014-versioned-production-contract.md) — Accepted em 8 de agosto de 2026; especializa a baseline da 0.8-MVP-05A sem executar produção
- [ADR-015 — Traefik, HTTPS e edge health-only](ADR-015-traefik-edge-and-tls.md) — Accepted em 10 de agosto de 2026; define file provider, HTTP-01, três modos exclusivos de binding e exposição provisória somente de `GET /health`, sem declarar estado live
- [ADR-016 — Recovery contract and tooling](ADR-016-recovery-contract-and-tooling.md) — Accepted em 12 de agosto de 2026; define backup lógico cifrado, round trip remoto, retenção trash-only e restore isolado antes da operação 07B
- [ADR-017 — Fronteira de confiança do proxy Vercel–Traefik](ADR-017-vercel-origin-proxy-trust-boundary.md) — Accepted provisionally em 13 de agosto de 2026; define proxy fail-closed, chave de origem, proveniência do IP e preservação HTTP sem ativar produção
- [ADR-018 — Contrato íntegro e ativação atômica da árvore de release](ADR-018-release-tree-atomic-activation.md) — Accepted em 14 de agosto de 2026; define metadata completa, staging/rollback canônicos, quarentena e troca exclusiva por `renameat2(RENAME_EXCHANGE)` sem executar mutação remota
- [ADR-019 — Valor esperado da oportunidade no ciclo comercial de Lead](ADR-019-lead-commercial-cycle-expected-value.md) — Accepted em 25 de agosto de 2026; define valor esperado nullable por ciclo comercial de Lead, comando dedicado e histórico de mudanças
