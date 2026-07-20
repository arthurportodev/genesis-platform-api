# ADR-006 — Modelo operacional multiagente

- **Status:** Accepted — implemented in task 0.2.2.4
- **Data:** 2026-07-20

## Contexto

A continuidade versionada, a proteção da `main` e a revisão proporcional já preservavam qualidade, mas tarefas transversais eram conduzidas por muitas etapas seriais e prompts repetitivos. A Tarefa 0.2.4 evidenciou que a revisão independente encontra defeitos antes do merge, ao mesmo tempo em que separar implementação, correções, documentação e encerramento em ciclos remotos distintos aumenta handoffs e duplicação.

O projeto precisa permitir colaboração entre agentes sem escrita concorrente, autonomia excessiva, perda de contexto ou redução dos gates humanos.

## Decisão

- Classificar toda tarefa como Simple, Normal ou Critical antes da escrita. Um único gatilho Critical eleva toda a tarefa.
- Usar três gates humanos: Gate 1 para arquitetura quando exigida, Gate 2 para aprovação da implementação e Gate 3 para autorização explícita do merge.
- Organizar a execução em quatro papéis: coordenador, builder, verifier e operador de entrega.
- Exigir verifier independente em tarefas Critical; em classes menores, permitir acumulação declarada ou etapa lógica independente conforme o risco.
- Manter um único writer por arquivo em cada fase. Writers paralelos usam branches e worktrees isolados, com ownership definido antes da escrita.
- Permitir correções locais de findings baixos e uma iteração de finding médio estritamente dentro do contrato. Findings médios de segurança, tenant, dados, schema, API ou ownership, findings altos e expansão de escopo interrompem a execução.
- Serializar integração, stage, commit e toda operação Git remota sob um único operador autorizado.
- Entregar código, testes e documentação durável no mesmo Pull Request. Evidências transitórias permanecem no GitHub.
- Usar squash como método normal e remover a branch após comprovação da incorporação.
- Avaliar o modelo por gates, findings escapados, conflitos de ownership, handoffs completos e um Pull Request por tarefa. Redução de prompts e validações repetidas é direcional, não critério de segurança.

## Alternativas consideradas

- **Execução inteiramente serial por prompts independentes:** rejeitada como padrão por repetir contexto, validações e fronteiras reversíveis sem ganho proporcional.
- **Múltiplos writers no mesmo checkout:** rejeitada por risco de conflito, atribuição ambígua e integração acidental.
- **Papéis ad hoc sem catálogo mínimo:** rejeitada porque dificulta autoridade, handoff e revisão independente.
- **Um agente por especialidade permanente:** rejeitada no estágio atual por aumentar coordenação; arquitetura, segurança, qualidade e documentação permanecem lentes.
- **Pull Request documental após o merge funcional:** rejeitado como padrão; fatos duráveis devem integrar o PR da tarefa e metadados operacionais ficam no GitHub.
- **Autonomia irrestrita para corrigir findings:** rejeitada porque pode mudar contrato, segurança ou produto sem novo gate.

## Consequências

- Tarefas de baixo risco podem avançar com menos cerimônia; tarefas Critical preservam arquitetura, verifier independente e três gates.
- Ownership e worktrees permitem paralelismo seguro apenas quando contratos e arquivos são disjuntos.
- O coordenador assume custo explícito de classificação, distribuição e integração.
- Handoffs passam a carregar base, arquivos, decisões, validações, findings e estado Git.
- Documentação deixa de duplicar SHAs, runs, jobs e conversas preservados pelo GitHub.
- O modelo depende de disciplina quando a ferramenta não impõe isolamento ou papéis tecnicamente.

## Limitações

- O modelo não substitui decisões do Product Owner nem garante que todo ambiente ofereça subagentes ou worktrees automáticos.
- Operações de produção, dados irreversíveis, mudanças no ruleset e decisões de produto exigem autorização própria.
- Não há aprovação humana obrigatória no ruleset enquanto não existir segundo mantenedor humano elegível.
- Squash-only e exclusão automática de branches foram aplicados na tarefa 0.2.2.5; nenhuma aprovação obrigatória foi adicionada e o ruleset `Protect main` permaneceu inalterado.
- As Skills `genesis-project-context` e `genesis-task-classification` são candidatas futuras; este ADR não as cria.

## Relações

- [Modelo operacional multiagente](../MULTI_AGENT_OPERATING_MODEL.md)
- [Classificação de tarefas](../TASK_CLASSIFICATION.md)
- [Templates de prompts](../PROMPT_TEMPLATES.md)
- [Fluxo de desenvolvimento](../DEVELOPMENT_WORKFLOW.md)
- [Protocolo de continuidade](../../AGENTS.md)

## Implementação

Implementado documentalmente na Tarefa de Governança 0.2.2.4. A Tarefa 0.2.2.5 aplicou squash-only e exclusão automática de branches sem alterar o ruleset ou adicionar aprovação obrigatória. A Tarefa 0.2.2.6 concluiu a normalização de EOL como primeiro piloto: coordenador, um único builder e verifier independente atuaram de forma sequencial, com ownership e handoffs aplicados. A decisão original permaneceu inalterada, e as Skills continuam adiadas. Nenhuma funcionalidade da API foi criada por estas tarefas de governança.
