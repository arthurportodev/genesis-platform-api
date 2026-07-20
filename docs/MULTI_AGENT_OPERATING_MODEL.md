# Modelo operacional multiagente

## Objetivo

Este documento é a fonte canônica da operação multiagente da Genesis Platform. O modelo reduz handoffs e prompts intermediários sem remover revisão independente, autorização humana ou controles proporcionais ao risco.

A [classificação da tarefa](TASK_CLASSIFICATION.md) determina a topologia, os gates e a validação mínima. Os [templates](PROMPT_TEMPLATES.md) aplicam estas políticas sem copiá-las.

O modelo não pressupõe que toda ferramenta ofereça subagentes ou worktrees automáticos. Quando o ambiente não permitir separar agentes, os papéis podem ser executados em etapas lógicas declaradas; um verifier independente real continua obrigatório quando a classe da tarefa assim exigir.

## Participantes e autoridade

- **Product Owner:** decide produto, prioridade e negócio; aprova os gates humanos.
- **ChatGPT:** apoia reidratação, arquitetura, requisitos, prompts, revisão e identificação de riscos.
- **Codex:** executa os papéis operacionais, altera o repositório e opera Git/GitHub somente dentro da autorização recebida.
- **GitHub:** preserva código incorporado, revisões, checks e evidências operacionais transitórias.

As ferramentas não substituem a autoridade do Product Owner. Conversa ou memória externa não substitui a hierarquia de fontes definida em [AGENTS.md](../AGENTS.md).

## Papéis operacionais

### Coordenador

- reidrata o contexto e confirma a classificação;
- define escopo, owners, dependências, gates e ordem de integração;
- distribui trabalho, consolida handoffs e controla o loop de correções;
- interrompe a execução quando a decisão excede a autonomia aprovada.

O coordenador não deve aprovar a própria implementação quando for exigido verifier independente.

### Builder

- altera somente os arquivos sob seu ownership;
- implementa código, testes e documentação afetada;
- executa validações proporcionais e entrega um handoff verificável;
- não executa operação Git remota salvo se também tiver recebido explicitamente o papel de operador de entrega.

### Verifier

- revisa o diff estável em modo somente leitura;
- verifica contrato, testes, segurança, documentação e limites de escopo;
- classifica findings e reverifica as correções permitidas;
- não altera arquivos nem aprova trabalho que ele próprio implementou quando a independência for obrigatória.

### Operador de entrega

- executa preflight, stage, commit, push, Pull Request, acompanhamento de CI, merge e limpeza somente quando autorizados;
- confirma escopo e estado Git em cada fronteira irreversível;
- não modifica a solução durante a entrega; qualquer correção retorna ao builder e ao verifier.

Uma mesma pessoa ou agente pode acumular papéis quando a classificação permitir, mas as responsabilidades e o momento de cada papel devem continuar explícitos.

## Lentes especializadas

Arquitetura e contexto, qualidade e testes, segurança e documentação são lentes aplicadas pelos papéis operacionais, não papéis permanentes adicionais. O coordenador atribui uma lente especializada quando o risco exigir. Segurança e isolamento multi-tenant devem ser avaliados por um verifier independente em tarefas Critical.

## Topologia por classe

- **Simple:** coordenador, builder e verifier por checklist podem ser acumulados de forma declarada pela mesma pessoa ou agente; o operador atua somente quando autorizado.
- **Normal:** coordenador e builder são obrigatórios; verifier pode ser um papel separado ou uma etapa lógica independente, conforme o risco.
- **Critical:** coordenador, builder e verifier independente são obrigatórios. O operador de entrega atua somente após os gates correspondentes.

Builders adicionais só são úteis quando os contratos estão estáveis, os conjuntos de arquivos são disjuntos e o ganho supera o custo de integração. A tabela completa está em [TASK_CLASSIFICATION.md](TASK_CLASSIFICATION.md).

## Worktrees e ownership

Antes da primeira escrita, o coordenador registra um mapa `arquivo ou glob -> builder`. Em cada fase existe um único writer por arquivo.

- Builders simultâneos usam branches e worktrees isolados.
- Sem isolamento garantido, writers trabalham de forma serial.
- Sobreposição de arquivos, contrato ainda instável ou migration dependente força serialização.
- Mudança de owner exige handoff aceito pelo coordenador antes da nova escrita.
- Arquivos não atribuídos permanecem somente leitura.
- O verifier permanece read-only mesmo quando compartilha o checkout.

Uma tarefa com um único builder pode usar apenas a branch da tarefa; não há benefício em criar worktree adicional sem paralelismo de escrita.

## Handoff

Todo handoff entre papéis deve informar:

- tarefa, classe e base SHA;
- branch ou worktree, quando aplicável;
- ownership recebido e arquivos alterados;
- decisões e invariantes preservados;
- validações executadas e seus resultados;
- findings, riscos e decisões pendentes;
- documentação afetada;
- operações Git realizadas e explicitamente não realizadas.

Handoff incompleto bloqueia integração e o gate seguinte.

## Paralelismo e integração

Podem ocorrer em paralelo quando não houver escrita concorrente nem dependência instável:

- leitura e levantamento de contexto;
- análise de alternativas;
- threat modeling;
- implementação em conjuntos disjuntos com contrato congelado;
- testes e documentação de um contrato já estável;
- revisões read-only por lentes diferentes.

Devem permanecer seriais:

- decisões arquiteturais e de produto;
- alterações sobre o mesmo arquivo ou contrato;
- migrations acopladas a entidades e invariantes ainda em evolução;
- integração de commits na branch da tarefa;
- stage e commit de integração;
- push, criação ou atualização de Pull Request, resolução de threads, merge e limpeza.

O coordenador integra entregas em ordem explícita e executa novamente as validações afetadas após cada integração. Conflito semântico não é resolução mecânica: retorna ao owner ou abre interrupção.

## Correções autônomas

O builder pode corrigir na mesma execução:

- findings baixos;
- inconsistências factuais inequívocas;
- links quebrados, duplicações e formatação introduzida;
- um finding médio estritamente contido no contrato, reversível e sem tocar segurança, tenant, dados, schema, API ou ownership.

Toda correção deve ser comunicada ao coordenador e reverificada. Para finding médio permitido, há no máximo uma iteração autônoma; persistência ou mudança de natureza interrompe o trabalho.

Não são autônomos:

- finding médio de segurança, tenant, dados, schema, API ou ownership;
- finding alto ou crítico;
- nova dependência, migration, endpoint ou papel permanente não aprovado;
- mudança de arquitetura, gate, produto ou regra de negócio;
- expansão material de escopo ou operação com risco de perda de dados.

## Gates e interrupção

Os três gates estão definidos em [TASK_CLASSIFICATION.md](TASK_CLASSIFICATION.md): arquitetura aprovada, implementação aprovada e merge autorizado.

Interrompa e devolva uma decisão objetiva ao Product Owner quando:

- faltar decisão de produto;
- surgir gatilho que eleve a classe;
- a base ou uma fonte canônica divergir;
- for necessário alterar o modelo, os gates, o ruleset ou o escopo material;
- uma correção ultrapassar a autonomia definida;
- houver segredo, produção, operação irreversível ou risco não aceito;
- o isolamento de writers ou a independência do verifier não puder ser garantido.

## Git, GitHub e documentação

Um único operador executa operações Git remotas. Commit, push, criação de PR e merge dependem do escopo e da autorização explícita da tarefa. Gate 3 nunca é inferido do Gate 2 ou do sucesso da CI.

Cada tarefa deve produzir um único Pull Request, com a documentação durável integrada ao mesmo diff funcional. O merge desse PR deve tornar o estado documentado verdadeiro. Branch, SHAs transitórios, run IDs, job IDs, timestamps e conversas permanecem no GitHub, salvo requisito explícito de auditoria.

Squash é o método normal de integração e a branch incorporada deve ser removida após sincronização e comprovação do merge. A configuração desejada de squash-only e exclusão automática de branch é distinta da política documentada e não deve ser tratada como aplicada antes de sua alteração efetiva no GitHub.

## Métricas do piloto

### Obrigatórias

- um Pull Request por tarefa;
- zero finding médio ou alto escapado;
- zero conflito de ownership;
- todos os gates exigidos cumpridos;
- todos os handoffs completos;
- zero Pull Request documental pós-merge.

### Direcionais

- redução de prompts intermediários;
- redução de linhas de instrução;
- redução de repetições locais da suíte completa.

As métricas direcionais não são critérios de segurança e não justificam remover validação, verifier ou gate.
