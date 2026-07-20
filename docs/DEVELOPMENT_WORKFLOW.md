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
- Integração normal por squash merge.
- O histórico deve permanecer linear e a exclusão da `main` é bloqueada.
- A branch incorporada é removida após sincronização e comprovação do merge.
- Segredos, `.env`, dependências, builds, logs e temporários nunca são versionados.

Squash-only e exclusão automática de branch são configurações desejadas, mas ainda não aplicadas no GitHub. A política documentada não deve ser confundida com enforcement existente.

## Responsabilidades institucionais

- **Arthur:** produto, prioridades, decisões de negócio, validação e aprovação dos gates.
- **ChatGPT:** contexto, arquitetura, requisitos, prompts, revisão e riscos.
- **Codex:** execução dos papéis operacionais, testes, migrations, infraestrutura e documentação; Git remoto somente quando autorizado.
- **Lovable:** frontend quando essa fase começar.
- **GitHub:** estado persistido, colaboração, revisão, checks e evidências transitórias.

## Contingência

Quando uma conversa ou agente perder contexto, não continuar por memória provável. Aplicar o processo de recuperação de [AGENTS.md](../AGENTS.md): reler documentos, inspecionar `main`, migrations, testes, PRs e Issues, reconciliar divergências e atualizar primeiro a memória oficial.
