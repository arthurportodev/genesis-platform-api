# Protocolo de continuidade

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

## Memória temporal canônica

Resolva fase, trabalho vigente, próxima tarefa, estado operacional, blockers,
decisões pendentes e restrições atuais exclusivamente em
`docs/memory/project-state.v1.json`. `docs/CURRENT_STATE.md` é sua projeção
determinística para leitura humana. Documentos estáveis e ADRs não substituem a
autoridade; `docs/TASK_LOG.md` é histórico. O Web mantém somente um pointer e
deve ser validado por receipt e `memoryRevision` antes do uso.

## Objetivo

O projeto não pode depender da memória de uma pessoa, conversa ou agente de IA. O repositório é a memória oficial e deve permitir reconstruir o contexto antes de qualquer decisão ou implementação.

## Reidratação orientada pelo delta

Antes de planejar ou implementar, responda:

1. O que esta tarefa muda?
2. Quais contratos ela toca?
3. Quais arquivos são autoridades?
4. Quais riscos são novos?

Leia primeiro a classificação, o fluxo operacional e somente as fontes
diretas do contrato. Em seguida, inspecione implementação, testes, CI e estado
remoto relacionados. Amplie a leitura apenas diante de um gatilho concreto e
registre fonte, gatilho e motivo. Base inesperada, autoridade contraditória,
fronteira protegida, finding High sem causa local e qualquer finding Critical
são gatilhos de expansão.

Use [docs/START_HERE.md](docs/START_HERE.md) como roteador, não como obrigação
de ler todo o projeto. A recuperação completa continua obrigatória quando o
delta não explicar o comportamento ou as fontes permanecerem inconsistentes.

## Autoridades por domínio

<!-- genesis-source-authorities:v1 implementation=main-code temporal=docs/memory/project-state.v1.json projection=derived architecture=accepted-adrs history=explicit -->

Não existe uma hierarquia linear única para perguntas de domínios diferentes:

- **verdade de implementação:** código, migrations e testes da `main`;
- **verdade temporal do projeto:**
  [project-state.v1.json](docs/memory/project-state.v1.json);
- **projeção humana:** [CURRENT_STATE.md](docs/CURRENT_STATE.md), sempre derivada
  da autoridade temporal e nunca editada manualmente;
- **decisões e justificativas arquiteturais:** ADRs aceitos;
- **histórico:** [TASK_LOG.md](docs/TASK_LOG.md), snapshots explicitamente
  históricos e o roadmap integralmente superseded;
- **evidência de colaboração:** Issues e Pull Requests;
- **contexto não autoritativo:** conversas e memórias externas.

ADRs aceitos orientam arquitetura, mas nunca vencem a autoridade temporal ao
resolver fase, trabalho vigente, próxima tarefa, blockers abertos, decisões
humanas ainda pendentes ou estado operacional documentado/observado. Código,
migrations e testes vencem documentação em perguntas de implementação. Não
corrija divergência por suposição: identifique primeiro o domínio e reconcilie a
fonte correspondente.

## Operação por tarefa

Toda tarefa deve ser classificada como Simple, Normal ou Critical antes da escrita. A execução usa quatro papéis: coordenador, builder, verifier e operador de entrega. Um único writer é owner de cada arquivo em cada fase; writers paralelos exigem worktrees isolados.

Use `$genesis-task-orchestrator` para intake e reidratação e
`$genesis-independent-verifier` para revisão independente. A invocação das duas
Skills é explícita em tarefas Critical. Skills orientam o processo; schemas,
scripts, testes e CI permanecem o enforcement determinístico.

Os gates são: Gate 1 para arquitetura quando exigida, Gate 2 para aprovação da implementação e Gate 3 para autorização explícita do merge. Interrompa quando surgir decisão ausente, elevação de classe, expansão material de escopo ou correção fora da autonomia aprovada.

Consulte [TASK_CLASSIFICATION.md](docs/TASK_CLASSIFICATION.md) para classes e gates, [MULTI_AGENT_OPERATING_MODEL.md](docs/MULTI_AGENT_OPERATING_MODEL.md) para papéis, ownership e autonomia, e [PROMPT_TEMPLATES.md](docs/PROMPT_TEMPLATES.md) para execução parametrizada.

## Papéis institucionais

### Arthur

- Product Owner;
- decisões de negócio e prioridades;
- validação funcional;
- aprovação final.

### ChatGPT

- arquitetura e reidratação de contexto;
- planejamento, requisitos e critérios de aceitação;
- criação de prompts e revisão técnica;
- continuidade e identificação de riscos.

### Codex

- implementação oficial de backend e frontend, testes, migrations e infraestrutura;
- atualização da documentação afetada;
- commits e Pull Requests somente quando autorizado.

### Lovable

- exploração e referência visual opcional para interfaces, sem substituir a
  implementação oficial pelo Codex.

### GitHub

- fonte oficial do estado persistido do projeto, de suas revisões e do CI.

## Regras obrigatórias

- Nenhuma tarefa começa sem reidratação.
- Nenhuma escrita começa sem classificação e ownership definidos.
- Nenhuma decisão importante fica somente em conversa.
- Nenhuma tarefa termina com documentação afetada desatualizada.
- Não implementar código especulativo nem antecipar tarefas futuras.
- Não modificar arquivos fora do escopo autorizado.
- Quando houver dúvida, parar e reconstruir o contexto.
- Não adivinhar decisões ausentes.
- Distinguir sempre implementado, planejado, adiado, fora do escopo e decisão aberta.

## Processo de recuperação

Quando o contexto estiver ausente ou inconsistente:

1. interromper a implementação;
2. ler os documentos na ordem obrigatória;
3. inspecionar a `main`;
4. verificar as migrations;
5. verificar Pull Requests e Issues;
6. comparar código, testes e documentação;
7. corrigir primeiro a memória oficial;
8. somente então continuar.

## Atualização documental por tarefa

Todo Pull Request deve avaliar se precisa atualizar:

- `docs/CURRENT_STATE.md`;
- `docs/ROADMAP.md`;
- `docs/TASK_LOG.md`;
- `docs/ARCHITECTURE.md`;
- `docs/DOMAIN_MODEL.md`;
- `docs/SECURITY.md`;
- um ADR;
- `README.md`.
