# ADR-012 — Development Operating System v2

- **Status:** Accepted
- **Data:** 2026-07-30

## Contexto

O modelo do ADR-006 estabeleceu classes, papéis e Gates, mas os dois
repositórios evoluíram parsers, fingerprints, perfis e CI de forma divergente.
O backend preservava tipo e modo, porém mudava o fingerprint em
`untracked -> tracked`; o frontend preservava o hash nessa transição, porém não
representava modo e symlink com a mesma integridade. Skills continuavam apenas
planejadas, a independência do verifier era documental e prompts ainda podiam
reidratar o projeto inteiro por hábito.

O Gate 1 read-only da tarefa `0.8.1.1` classificou a evolução como Critical e o
Product Owner aprovou as decisões abaixo.

## Decisão

### Autoridade e distribuição

O backend é a autoridade canônica dos contratos operacionais comuns. O
frontend mantém cópia controlada com versão, upstream, hashes e fixtures de
paridade, além de seus comandos específicos. Não será criado pacote ou plugin
compartilhado nesta versão.

### Reidratação e Skills

A reidratação começa por delta, contratos, autoridades e riscos novos. Fontes
diretas precedem implementação e uma expansão exige gatilho registrado.
Recuperação ampla é o fail-safe para contradição ou risco não explicado.

As Skills repo-local `genesis-task-orchestrator` e
`genesis-independent-verifier` orientam intake e revisão. Em Critical, ambas
são invocadas explicitamente. Skills não substituem schemas, scripts, testes,
CI ou Gates; os documentos preservam o fallback.

### Manifesto, findings e evidências

Task Manifest V2 acrescenta versão de contrato, transições Git, níveis,
rehidratação, autonomia e autoridade. V1 e V2 coexistem por dual-read e
normalização interna. Findings, verifier evidence, handoff e Evidence Manifest
possuem schemas versionados.

A severidade define rigor; a natureza da correção define decisão. High autônomo
exige invariante aprovado, correção dominante, regressão específica, validações
focadas e Critical final, novo candidato, resolução estruturada e reverificação
independente. Critical interrompe, salvo reclassificação objetiva pelo verifier
sem mudança do candidato, decisão material ou contrato.

### Fingerprints

O sistema emite:

- fingerprint V1 durante a coexistência;
- `contentFingerprint` canônico de path, tipo, modo e bytes;
- `gitStateFingerprint` de branch, base, HEAD, commit, stage, worktree e
  tracked/untracked;
- `candidateId` derivado de task, base, versão e content fingerprint.

O content fingerprint é estável em `untracked -> tracked` quando o candidato é
idêntico. Conteúdo, path, arquivo extra, modo, symlink, deleção e tipo irregular
continuam detectados ou rejeitados.

### Validação e verifier

Validação usa quatro níveis: imediato, focado, integração e completo. Critical
executa verificações focadas durante a construção, integrações nas fronteiras,
uma validação completa no candidato final, fingerprints e verifier.

O verifier Critical opera em execução separada e read-only. Sua evidência
registra executores, estado e fingerprints antes/depois, cobertura, fontes,
findings e recomendação. Alteração do candidato, executor igual ao builder ou
ausência de evidência bloqueia Gate 2.

### Operação remota futura

Operador de entrega Git e operador de mutação remota são papéis distintos. O
operador remoto futuro consumirá envelope aprovado, estado esperado, allowlist,
dry run, locks e rollback autorizado; usará um writer por recurso, parará em
drift e produzirá Evidence Manifest. Esta decisão não cria nem executa esse
operador.

## Alternativas consideradas

- **Pacote compartilhado:** adiado para evitar release e instalação como nova
  dependência da governança.
- **Plugin ou Skills globais:** rejeitados como fonte primária porque não
  acompanham necessariamente um checkout limpo.
- **Fingerprint único de conteúdo:** não registra o estado Git necessário para
  diagnóstico e Gates.
- **Transições excepcionais no fingerprint V1:** rejeitadas por manter
  identidade incidental e ampliar casos especiais.
- **Bloquear todo High:** seguro, mas impede correções inequívocas já
  contratadas; o envelope fechado preserva o rigor.

## Consequências

- O backend ganha novos schemas, Skills e checks de CI.
- O frontend precisa portar o conjunto canônico antes de concluir a iniciativa.
- Durante a coexistência, consumidores devem distinguir fingerprint V1,
  conteúdo, estado Git e candidate ID.
- A paridade entre repositórios depende de hashes e fixtures até que uma futura
  decisão aprove outro mecanismo de distribuição.
- Prompts ficam menores sem reduzir recuperação, verifier ou Gates.

## Compatibilidade e rollback

V1 permanece aceito e emitido. Novas tarefas Critical usam V2; tarefas em
andamento podem permanecer em V1. Em falha, a emissão e o consumo V2 podem ser
desativados mantendo parser, perfis e fingerprint V1. A remoção do V1 exige
tarefa e Gate próprios após o período de coexistência.

## Relações

- Estende o [ADR-006](ADR-006-multi-agent-operating-model.md), sem substituir
  classes, papéis ou Gates.
- Não altera o [ADR-011](ADR-011-production-architecture.md); apenas define o
  contrato de evidência para uma operação futura.
- O frontend deve referenciar este ADR como autoridade do contrato comum.

## Implementação

A tarefa `0.8.1.1` implementa primeiro a autoridade backend. O port e a paridade
frontend constituem o segundo candidato sequencial. Nenhum merge dispensa Gate
3 e nenhuma mutação de produção é autorizada.
