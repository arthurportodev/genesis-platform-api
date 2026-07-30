# Comece aqui

Este diretório é a memória versionada da Genesis Platform. Comece pelo delta
da tarefa e use as fontes abaixo como roteamento; não leia a sequência inteira
sem um gatilho concreto.

## Roteamento de fontes

1. [Visão do produto](PROJECT_OVERVIEW.md): propósito, público e limites do produto.
2. [Estado atual](CURRENT_STATE.md): fotografia curta do que existe e do próximo passo.
3. [Roadmap](ROADMAP.md): direção planejada e ordem das tarefas.
4. [Arquitetura](ARCHITECTURE.md): estrutura técnica e fronteiras atuais.
5. [Modelo de domínio](DOMAIN_MODEL.md): entidades e relações implementadas.
6. [Segurança](SECURITY.md): controles, ameaças tratadas e limitações.
7. [Produção](PRODUCTION.md): plano operacional, tarefas, DAG e critérios de abertura.
8. [Classificação de tarefas](TASK_CLASSIFICATION.md): classes, gatilhos, gates e validação mínima.
9. [Modelo operacional multiagente](MULTI_AGENT_OPERATING_MODEL.md): papéis, ownership, worktrees, autonomia e handoffs.
10. [Fluxo de desenvolvimento](DEVELOPMENT_WORKFLOW.md): ciclo entre pessoas, agentes, Git e GitHub.
11. [Templates de prompts](PROMPT_TEMPLATES.md): estruturas parametrizadas que aplicam as políticas canônicas.
12. [Histórico de tarefas](TASK_LOG.md): entregas consolidadas.
13. [ADRs](decisions/README.md): decisões arquiteturais e suas justificativas.

O protocolo obrigatório para pessoas e agentes está em [AGENTS.md](../AGENTS.md).

Para intake, classificação e plano mínimo, invoque explicitamente
`$genesis-task-orchestrator` em tarefas Critical. Para a revisão Critical final,
invoque `$genesis-independent-verifier`. O fallback sem Skills é aplicar
diretamente `AGENTS.md`, a classificação, o fluxo e os templates versionados.

## Como recuperar contexto

Se o contexto estiver ausente, desatualizado ou contraditório, interrompa a implementação. Leia o [estado atual](CURRENT_STATE.md), confira os ADRs relacionados, inspecione a `main`, as migrations, os testes e os Pull Requests. Corrija primeiro a memória oficial quando ela estiver divergente.

Decisões persistentes ficam em [docs/decisions](decisions/README.md). Planejamento fica no [roadmap](ROADMAP.md); ele não comprova implementação. O estado real é verificado no código, migrations e testes da `main`, que prevalecem sobre estes documentos em caso de divergência.
