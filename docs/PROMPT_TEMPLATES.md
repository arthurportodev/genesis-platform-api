# Templates de prompts

## Uso

Estes templates compactos parametrizam tarefas sem repetir política. Preencha apenas fatos confirmados e sempre aplique:

- [protocolo e hierarquia de fontes](../AGENTS.md);
- [classificação e gates](TASK_CLASSIFICATION.md);
- [papéis, ownership, autonomia e handoffs](MULTI_AGENT_OPERATING_MODEL.md);
- [fluxo Git e de entrega](DEVELOPMENT_WORKFLOW.md).

Parâmetros entre `<...>` são obrigatórios quando aplicáveis. Uma operação Git não é autorizada apenas por aparecer no template.

Cada prompt contém somente o delta: objetivo, escopo, contratos e invariantes específicos, riscos, critérios de aceite e diferenças em relação às políticas canônicas. Não copie integralmente os documentos referenciados acima.

## Tarefa Simple

```text
Tarefa: <identificador e título>
Base/branch: <SHA e branch>
Delta: <objetivo, escopo, contrato específico, riscos e aceite>
Objetivo: executar uma mudança local, reversível e sem gatilho Critical.
Papéis: um builder acumula coordenação e verifier por checklist; <operador, se autorizado>.
Autonomia: correções mecânicas e funcionais locais dentro do contrato congelado.
Restrições: <fora do escopo>; não antecipar tarefas; um writer por arquivo.
Gates: sem Task Packet ou Gate 1 separado; Gate 2 proporcional; merge exige Gate 3.
Interromper: gatilho Critical, decisão ausente, expansão de escopo ou base divergente.
Handoff: classe confirmada, base SHA, arquivos, decisões, validações, findings, docs e Git realizado/não realizado.
```

## Arquitetura

```text
Tarefa: <identificador e título>
Base: <SHA>
Parâmetros: <problema, fontes, restrições, alternativas, critérios>
Objetivo: produzir decisão implementável para Gate 1, sem escrever a solução.
Papéis: coordenador; <lenses/verifiers consultivos>.
Autonomia: investigar e comparar alternativas; não decidir produto ausente.
Restrições: sem código, Git remoto ou expansão além do problema aprovado.
Gates: saída é proposta para Gate 1; não iniciar implementação antes da aprovação.
Interromper: fontes contraditórias, requisito ausente, risco não aceito ou mudança de classe.
Handoff: classe, contexto, alternativas, decisão recomendada, contratos, riscos, ownership, validações e pendências.
```

## Implementação coordenada

```text
Tarefa/classe: <identificador, título e classe>
Base/branch: <SHA e branch>
Delta: <Gate 1 ou justificativa de dispensa, escopo, contratos, riscos, aceite e validações>
Manifesto: <obrigatório para Critical; opcional para Normal; perfil de validação>
Objetivo: implementar código, testes e documentação afetada até ficar pronta para Gate 2.
Papéis: coordenador; um builder <nome>; verifier final <nome/modo>; verifier incremental somente por risco; sem operador remoto salvo autorização separada.
Autonomia: correções mecânicas e funcionais locais dentro do contrato congelado; rodadas são telemetria.
Restrições: um writer por arquivo; worktrees para writers paralelos; <fora do escopo>; sem Git remoto.
Gates: Gate 1 deve estar satisfeito quando exigido; não ultrapassar Gate 2.
Interromper: condições do modelo operacional, conflito semântico, classe elevada ou autonomia excedida.
Handoff: base/heads, ownership, arquivos, decisões, validações, findings, docs e operações Git realizadas/não realizadas.
```

## Revisão Critical

```text
Tarefa: <identificador e contrato aprovado>
Diff/base: <base SHA, head SHA e arquivos>
Parâmetros: <invariantes, ameaças, critérios, validações obrigatórias>
Objetivo: revisar integralmente o diff estável e produzir evidência para Gate 2.
Papéis: verifier independente read-only; coordenador; builder apenas para correções permitidas.
Autonomia: classificar findings; builder corrige baixos e uma iteração média permitida; verifier reverifica.
Restrições: verifier não escreve nem aprova trabalho próprio; sem entrega remota ou mudança de contrato.
Gates: recomendar aprovar Gate 2 somente sem finding médio/alto pendente.
Interromper: finding médio restrito, finding alto, expansão de escopo, decisão ausente ou impossibilidade de independência.
Handoff: findings com severidade/evidência, cobertura revisada, correções, reverificação, riscos residuais e recomendação do Gate 2.
```

## Entrega: commit + push + PR + CI

```text
Tarefa: <identificador e título>
Base/branch: <SHA e branch>
Parâmetros: <Gate 2 aprovado, arquivos autorizados, mensagem, remote, base do PR>
Objetivo: consolidar o diff aprovado, publicar uma vez, abrir/atualizar um PR e acompanhar CI/feedback.
Papéis: operador de entrega único; coordenador somente para decisão.
Autonomia: correção nenhuma durante entrega; falha retorna ao builder/verifier. Uma nova leitura de falha transitória é permitida sem mutação.
Restrições: stage explícito; sem arquivos fora do escopo; sem force push, merge, tag, release ou deploy.
Gates: exigir Gate 2 e autorização remota explícita; saída aguarda Gate 3.
Interromper: diff mudou, CI falhou de modo não transitório, feedback exige código ou estado remoto divergiu.
Handoff: commit, branch/PR, checks, comentários/threads, escopo publicado, estado Git e operações não realizadas.
```

## Merge + limpeza + CI pós-merge

```text
Tarefa/PR: <identificador, número e URL>
Parâmetros: <Gate 3 explícito, PR, head SHA, fingerprint ou commit aprovado, CI, branch atualizada e bloqueios>
Objetivo: executar squash merge, comprovar incorporação, sincronizar, remover branch e acompanhar CI pós-merge.
Papéis: operador de entrega único; coordenador para qualquer divergência.
Autonomia: somente operações mecânicas autorizadas e verificações read-only.
Restrições: sem alterar conteúdo, burlar proteção, force push, tag, release ou deploy.
Gates: Gate 3 é pré-condição obrigatória e específica para o PR atual.
Interromper: check/finding/thread pendente, head inesperado, conflito, autorização ambígua ou falha pós-merge que exija correção.
Handoff: squash/base final, PR incorporado, branches removidas, CI pós-merge, working tree e operações não realizadas.
```
