# Comece aqui

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

Este diretório é a memória versionada da Genesis Platform. Comece pelo delta
da tarefa e use as fontes abaixo como roteamento; não leia a sequência inteira
sem um gatilho concreto.

## Autoridades por domínio e roteamento

<!-- genesis-source-authorities:v1 implementation=main-code temporal=docs/memory/project-state.v1.json projection=derived architecture=accepted-adrs history=explicit -->

- **Implementação:** código, migrations e testes da `main`.
- **Tempo do projeto:** [memória canônica](memory/project-state.v1.json), que
  resolve fase, trabalho, operação, blockers, decisões e restrições.
- **Leitura humana do tempo:** [estado atual](CURRENT_STATE.md), projeção
  determinística que nunca deve ser editada manualmente.
- **Arquitetura:** [arquitetura](ARCHITECTURE.md),
  [segurança](SECURITY.md), [produção](PRODUCTION.md) e
  [ADRs aceitos](decisions/README.md) preservam contratos e justificativas.
- **Produto:** [direção de produto](PRODUCT_DIRECTION.md) preserva a tese e os
  critérios de escopo; [visão do produto](PROJECT_OVERVIEW.md) e
  [modelo de domínio](DOMAIN_MODEL.md) descrevem propósito, limites e entidades.
- **Histórico:** [histórico de tarefas](TASK_LOG.md) é append-only e o
  [roadmap](ROADMAP.md) é integralmente histórico/superseded.
- **Operação do desenvolvimento:** [classificação](TASK_CLASSIFICATION.md),
  [modelo multiagente](MULTI_AGENT_OPERATING_MODEL.md),
  [fluxo](DEVELOPMENT_WORKFLOW.md) e [templates](PROMPT_TEMPLATES.md).

ADRs não substituem a memória canônica para fase, trabalho vigente, próxima
tarefa, blockers, decisões pendentes ou estado operacional. `CURRENT_STATE.md`
é somente uma projeção. Em divergência de implementação, inspecione código,
migrations e testes da `main`.

O protocolo obrigatório para pessoas e agentes está em [AGENTS.md](../AGENTS.md).

Para intake, classificação e plano mínimo, invoque explicitamente
`$genesis-task-orchestrator` em tarefas Critical. Para a revisão Critical final,
invoque `$genesis-independent-verifier`. O fallback sem Skills é aplicar
diretamente `AGENTS.md`, a classificação, o fluxo e os templates versionados.
Em deltas de frontend, produto ou experiência, aplique
`$genesis-frontend-product-engineer` somente como lente especializada do
builder e carregue as autoridades adicionais apenas quando o delta exigir.

## Como recuperar contexto

Se o contexto estiver ausente, desatualizado ou contraditório, interrompa a
implementação. Identifique o domínio da pergunta, consulte sua autoridade,
inspecione a `main`, as migrations, os testes e os Pull Requests quando houver
impacto de implementação e corrija primeiro a fonte correspondente.

Decisões persistentes ficam em [docs/decisions](decisions/README.md). O roadmap
preserva planejamento histórico e não comprova implementação nem estado
temporal. Código, migrations e testes da `main` comprovam implementação; a
memória canônica comprova o tempo do projeto.
