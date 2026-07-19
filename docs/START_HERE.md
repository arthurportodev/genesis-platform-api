# Comece aqui

Este diretório é a memória versionada da Genesis Platform. Leia somente o necessário para a tarefa, mas sempre comece pela sequência abaixo.

## Ordem recomendada

1. [Visão do produto](PROJECT_OVERVIEW.md): propósito, público e limites do produto.
2. [Estado atual](CURRENT_STATE.md): fotografia curta do que existe e do próximo passo.
3. [Roadmap](ROADMAP.md): direção planejada e ordem das tarefas.
4. [Arquitetura](ARCHITECTURE.md): estrutura técnica e fronteiras atuais.
5. [Modelo de domínio](DOMAIN_MODEL.md): entidades e relações implementadas.
6. [Segurança](SECURITY.md): controles, ameaças tratadas e limitações.
7. [Fluxo de desenvolvimento](DEVELOPMENT_WORKFLOW.md): operação entre pessoas, agentes e GitHub.
8. [Histórico de tarefas](TASK_LOG.md): entregas consolidadas.
9. [ADRs](decisions/README.md): decisões arquiteturais e suas justificativas.

O protocolo obrigatório para pessoas e agentes está em [AGENTS.md](../AGENTS.md).

## Como recuperar contexto

Se o contexto estiver ausente, desatualizado ou contraditório, interrompa a implementação. Leia o [estado atual](CURRENT_STATE.md), confira os ADRs relacionados, inspecione a `main`, as migrations, os testes e os Pull Requests. Corrija primeiro a memória oficial quando ela estiver divergente.

Decisões persistentes ficam em [docs/decisions](decisions/README.md). Planejamento fica no [roadmap](ROADMAP.md); ele não comprova implementação. O estado real é verificado no código, migrations e testes da `main`, que prevalecem sobre estes documentos em caso de divergência.
