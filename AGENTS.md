# Protocolo de continuidade

## Objetivo

O projeto não pode depender da memória de uma pessoa, conversa ou agente de IA. O repositório é a memória oficial e deve permitir reconstruir o contexto antes de qualquer decisão ou implementação.

## Ordem de leitura obrigatória

Antes de planejar ou implementar:

1. [docs/START_HERE.md](docs/START_HERE.md)
2. [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md)
3. [docs/CURRENT_STATE.md](docs/CURRENT_STATE.md)
4. [docs/ROADMAP.md](docs/ROADMAP.md)
5. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
6. [ADRs relacionados](docs/decisions/README.md)
7. migrations relacionadas
8. último Pull Request mesclado
9. Pull Requests e Issues abertos
10. código e testes relacionados à tarefa

## Hierarquia das fontes

Em caso de divergência, prevalecem:

1. código, migrations e testes da `main`;
2. ADRs aceitos;
3. [CURRENT_STATE.md](docs/CURRENT_STATE.md);
4. [ROADMAP.md](docs/ROADMAP.md);
5. [TASK_LOG.md](docs/TASK_LOG.md);
6. Issues e Pull Requests;
7. conversas e memórias externas.

Não corrija uma divergência por suposição. Identifique a fonte autoritativa e registre a decisão persistente.

## Papéis

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

- implementação, testes, migrations e infraestrutura;
- atualização da documentação afetada;
- commits e Pull Requests somente quando autorizado.

### Lovable

- frontend e interface quando a fase de frontend for iniciada.

### GitHub

- fonte oficial do estado persistido do projeto, de suas revisões e do CI.

## Regras obrigatórias

- Nenhuma tarefa começa sem reidratação.
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
