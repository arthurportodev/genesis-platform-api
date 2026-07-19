# Fluxo de desenvolvimento

## Ciclo de uma tarefa

1. reidratação do contexto;
2. definição do objetivo;
3. Issue, quando utilizada;
4. criação de uma branch exclusiva;
5. implementação dentro do escopo;
6. testes proporcionais ao risco;
7. revisão do diff, segurança e documentação;
8. commit intencional;
9. push normal;
10. Pull Request;
11. GitHub Actions;
12. revisão final;
13. squash merge;
14. sincronização local e exclusão das branches incorporadas;
15. atualização do estado oficial.

Commits, pushes, PRs e merges exigem autorização explícita quando a tarefa não os solicitar.

## Estrutura padrão dos prompts

Padrão aprovado pelo Product Owner:

1. contexto;
2. estado inicial;
3. objetivo;
4. justificativa;
5. dependências;
6. escopo;
7. fora do escopo;
8. decisões a preservar;
9. arquivos envolvidos;
10. passos;
11. restrições;
12. segurança;
13. critérios de aceitação;
14. testes;
15. Git;
16. relatório final.

## Princípios

- Dizer explicitamente o que fazer e o que não fazer.
- Não criar código especulativo nem antecipar módulos.
- Testar de acordo com o risco.
- Parar diante de falha inesperada e diagnosticar antes de corrigir.
- Não esconder limitações ou tratar planejamento como implementação.
- Não declarar revisão linha a linha sem realizá-la.
- Preservar mudanças legítimas já existentes no working tree.

## Convenções Git atuais

- `main` é protegida por um ruleset ativo e deve permanecer estável.
- Uma branch por tarefa.
- Alterações na `main` entram obrigatoriamente por Pull Request; push direto e force push são bloqueados.
- O check `Validate backend` deve passar e a branch do Pull Request deve estar atualizada com a `main`.
- Todas as conversas de revisão devem ser resolvidas antes do merge.
- Nenhuma aprovação humana é obrigatória nesta fase.
- Integração normal por squash merge.
- O histórico deve permanecer linear e a exclusão da `main` é bloqueada.
- Branches são excluídas após sincronização e comprovação de incorporação.
- Segredos, `.env`, dependências, builds, logs e temporários nunca são versionados.

## Responsabilidades

- **Arthur:** produto, prioridades, decisões de negócio, validação e aprovação.
- **ChatGPT:** contexto, arquitetura, requisitos, prompts, revisão e riscos.
- **Codex:** implementação, testes, migrations, infraestrutura e documentação; Git remoto somente quando autorizado.
- **Lovable:** frontend quando essa fase começar.
- **GitHub:** estado persistido, colaboração, revisão e CI.

## Contingência

Quando uma conversa ou agente perder contexto, não continuar por memória provável. Aplicar o processo de recuperação de [AGENTS.md](../AGENTS.md): reler documentos, inspecionar `main`, migrations, testes, PRs e Issues, reconciliar divergências e atualizar primeiro a memória oficial.
