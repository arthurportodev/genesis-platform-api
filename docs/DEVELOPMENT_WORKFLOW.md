# Fluxo de desenvolvimento

## Ciclo de uma tarefa

1. reidratar o contexto conforme [AGENTS.md](../AGENTS.md);
2. classificar a tarefa e definir ownership;
3. obter Gate 1 quando exigido;
4. criar uma branch exclusiva e worktrees para writers paralelos;
5. implementar código, testes e documentação durável dentro do escopo;
6. verificar o diff e aplicar as correções autônomas permitidas;
7. obter Gate 2 com findings e validações conhecidos;
8. executar commit, push, Pull Request e CI quando autorizados;
9. obter Gate 3 específico para o PR pronto;
10. executar squash merge, sincronizar, remover a branch e acompanhar a CI pós-merge.

A [classificação](TASK_CLASSIFICATION.md) define os gates, papéis e checks mínimos. O [modelo operacional](MULTI_AGENT_OPERATING_MODEL.md) define worktrees, ownership, autonomia, handoffs e interrupções.

Commits, pushes, PRs e merges exigem autorização explícita quando a tarefa não os solicitar. Gate 2 não autoriza implicitamente operação remota, e Gate 3 nunca é presumido pelo sucesso da CI.

## Contrato baseado no delta

O prompt de uma tarefa registra objetivo, escopo, contratos e invariantes específicos, riscos, critérios de aceite e diferenças em relação ao padrão. Políticas duráveis são referenciadas em vez de copiadas integralmente.

- **Simple:** um builder, sem Task Packet ou Gate 1 separado, teste focado e entrega simplificada.
- **Normal:** contrato curto, um builder, verifier final focado, validação proporcional e manifesto opcional.
- **Critical:** decisão de produto quando aplicável, Gate 1, manifesto e Task Packet obrigatórios, verifier incremental por risco, verifier independente final, Gate 2 integral e Gate 3 humano.

O registro de cobertura separa fontes diretas, fontes expandidas, gatilho e
motivo. Recuperação ampla é fail-safe para autoridade ausente, contradição ou
risco que as fontes diretas não expliquem.

## Manifesto operacional local

Tarefas Normal quando útil e todas as tarefas Critical usam `.codex/task-manifest.json`. O arquivo é transitório, não contém segredos, permanece ignorado somente por `.git/info/exclude` e não substitui documentação durável. O exemplo versionado está em `.codex/task-manifest.example.json`.

O manifesto V2 declara versão de contrato, identidade e classe, branch, base,
transições Git esperadas, paths permitidos/protegidos, artefatos locais, perfil,
níveis, reidratação, autonomia e autoridade dos contratos. O parser mantém
dual-read e normaliza V1/V2; V1 não é removido nesta etapa. Os comandos são:

- `npm run task:preflight`: valida manifesto, Git, escopo e artefatos sem modificar o repositório;
- `npm run task:fingerprint`: calcula o SHA-256 determinístico do candidato; `-- --json` produz saída machine-readable e `-- --verify-transition <referencia.json>` compara o index/commit com a referência pré-stage;
- `npm run task:contracts`: valida schemas, o manifesto-exemplo, Skills e hashes do conjunto canônico; `-- --validate-instance <schema> <arquivo.json>` aplica o schema completo e as invariantes semânticas a uma evidência;
- `npm run task:validate`: executa o perfil `docs`, `focused`, `normal` ou `critical`.

O perfil `focused` aceita somente nomes existentes em `package.json` que também pertençam à allowlist versionada de validações read-only; não aceita comandos shell, scripts mutantes, recursivos ou lifecycle hooks pelo manifesto. O perfil `critical` delega à validação integral canônica e uma tarefa Critical não pode selecionar perfil inferior nem omitir o Task Packet.

## Identidade do candidato

O dual-output preserva o fingerprint V1 e acrescenta:

- `contentFingerprint`: path, tipo, modo e identidade de conteúdo após os clean
  filters do Git, estável em `untracked -> tracked` quando esses elementos não
  mudam, inclusive sob normalização de EOL;
- `gitStateFingerprint`: branch, base, HEAD, committed, stage, unstaged e
  untracked;
- `candidateId`: task, base, versão do contrato e `contentFingerprint`.

Conteúdo, path, arquivo adicional, modo, symlink, deleção e tipo irregular
continuam detectados. Gate e verifier vinculam aprovação ao `candidateId`.
Uma mudança de estado só é aceita automaticamente quando conteúdo, candidate
ID e paths permanecem estáveis; `untracked -> tracked` precisa estar declarado
em `expectedTransitions`. Antes do stage, a saída JSON é preservada como
referência transitória. Depois do stage e depois do commit,
`--verify-transition` exige candidato integral, index canônico equivalente e
ausência de conteúdo unstaged ou untracked; partial stage, index stale, modo ou
blob divergente bloqueiam a transição.

Task Packet, findings, evidência do verifier e handoff só ficam fora do candidato
quando são arquivos regulares locais, ignorados e não rastreados. Um path de
artefato rastreado ou não ignorado continua visível ao fingerprint e reprova o
preflight; o manifesto não pode ser usado como pathspec de ocultação.

## Validação proporcional e evidências

Nível 1 é imediato; Nível 2 fecha um bloco; Nível 3 cobre integrações; Nível 4
executa uma vez no candidato final. Critical usa focadas durante a construção,
integração, Critical final, fingerprints e verifier. Mudança do
`contentFingerprint` após o Nível 4 exige reverificação da cobertura afetada.

Findings usam `finding.v1`, revisão Critical usa `verifier-evidence.v1` e o
handoff usa `handoff.v1`. O enforcement valida tipos, enums, padrões,
obrigatoriedade, propriedades adicionais, condicionais e referências entre
schemas antes das invariantes semânticas. Evidências transitórias ficam fora do
candidato ou no GitHub, conforme o Task Packet.

Ao validar `verifier-evidence.v1`, o CLI recompõe os paths do candidato atual e
os compara a `candidatePaths`, `reviewedFiles` e à contagem de cobertura. Uma
recomendação `approve` não é aceita sem esse contexto, com limitation, finding
pendente ou binding divergente.

## Gate 3 conciso

O Gate 3 permanece humano e verifica somente o Pull Request correto, head SHA, fingerprint ou commit aprovado, CI verde, branch atualizada, ausência de bloqueios e autorização explícita. Detalhes já comprovados no Gate 2 não são repetidos.

## Um Pull Request por tarefa

Código, testes, migrations e documentação durável afetada devem integrar o mesmo Pull Request. O conteúdo é redigido para que o merge torne o estado documentado verdadeiro, evitando um PR documental de encerramento.

Branch, SHAs transitórios, run IDs, job IDs, timestamps, comentários e conversas de revisão permanecem no GitHub, salvo requisito explícito de auditoria. `CURRENT_STATE.md`, `ROADMAP.md` e `TASK_LOG.md` registram apenas estado e resultados duráveis.

## Coordenação e entrega

- Um único writer é owner de cada arquivo em cada fase.
- Writers simultâneos usam branches e worktrees isolados; sem isolamento, a escrita é serial.
- O coordenador integra handoffs aceitos na branch da tarefa.
- Um único operador executa stage/commit de integração e operações Git remotas.
- Correção exigida durante entrega retorna ao builder e passa pela reverificação aplicável.
- Os [templates de prompts](PROMPT_TEMPLATES.md) parametrizam cada etapa sem duplicar as políticas canônicas.

## Princípios

- Dizer explicitamente o que fazer e o que não fazer.
- Não criar código especulativo nem antecipar módulos.
- Testar de acordo com o risco e a classe da tarefa.
- Parar diante de falha inesperada e diagnosticar antes de corrigir.
- Não esconder limitações ou tratar planejamento como implementação.
- Não declarar revisão linha a linha sem realizá-la.
- Preservar mudanças legítimas já existentes no working tree.
- Não reduzir controles apenas para atingir métricas de velocidade ou quantidade de prompts.

## Convenções Git atuais

- `main` é protegida por um ruleset ativo e deve permanecer estável.
- Uma branch por tarefa.
- Alterações na `main` entram obrigatoriamente por Pull Request; push direto e force push são bloqueados.
- O check `Validate backend` deve passar e a branch do Pull Request deve estar atualizada com a `main`.
- Todas as conversas de revisão devem ser resolvidas antes do merge.
- Nenhuma aprovação humana é obrigatória enquanto não existir segundo mantenedor humano elegível.
- Somente squash merge é permitido; merge commits e rebase merges estão desabilitados.
- O histórico deve permanecer linear e a exclusão da `main` é bloqueada.
- A branch remota incorporada é excluída automaticamente pelo GitHub; a branch local ainda é removida após sincronização e comprovação do merge.
- Segredos, `.env`, dependências, builds, logs e temporários nunca são versionados.

Squash-only e exclusão automática de branch estão aplicados nas configurações do repositório. O ruleset `Protect main` permanece inalterado: Gate 3 continua obrigatório, e CI verde não autoriza merge automaticamente.

## Fim de linha

- `.gitattributes` é a fonte canônica e define `* text=auto eol=lf`.
- Não altere `core.autocrlf` local ou global para aplicar a política do projeto.
- Arquivos textuais tracked e novos arquivos textuais usam LF; toda exceção real deve ser declarada no próprio `.gitattributes`. Não há exceção atual.
- `text=auto` mantém arquivos detectados como binários fora da conversão de texto. Uma regra específica só deve ser adicionada diante de um caso real.
- Novos checkouts e arquivos adicionados devem respeitar os atributos; uma renormalização futura deve ser auditada antes da integração.
- Verificações de EOL e de diff usam o checkout real. Não copie arquivos para uma árvore artificial para produzir um resultado diferente do que Git, build e testes consomem.

## Responsabilidades institucionais

- **Arthur:** produto, prioridades, decisões de negócio, validação e aprovação dos gates.
- **ChatGPT:** contexto, arquitetura, requisitos, prompts, revisão e riscos.
- **Codex:** execução dos papéis operacionais e implementação oficial de backend
  e frontend, testes, migrations, infraestrutura e documentação; Git remoto
  somente quando autorizado.
- **Lovable:** exploração e referência visual opcional para interfaces, sem
  substituir a implementação oficial pelo Codex.
- **GitHub:** estado persistido, colaboração, revisão, checks e evidências transitórias.

## Contingência

Quando uma conversa ou agente perder contexto, não continuar por memória provável. Aplicar o processo de recuperação de [AGENTS.md](../AGENTS.md): reler documentos, inspecionar `main`, migrations, testes, PRs e Issues, reconciliar divergências e atualizar primeiro a memória oficial.
