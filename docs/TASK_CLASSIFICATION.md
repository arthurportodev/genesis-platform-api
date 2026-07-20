# Classificação de tarefas

## Objetivo

Toda tarefa deve ser classificada antes do planejamento ou da escrita. A classificação define papéis, gates e validação mínima; não limita validações adicionais justificadas pelo risco.

Na dúvida, use a classe mais alta. Um único gatilho Critical torna toda a tarefa Critical, mesmo quando o diff esperado é pequeno.

## Classes

### Simple

Mudança local, reversível e coberta por padrão existente, sem decisão arquitetural ou de produto. Não altera segurança, tenant, dados persistidos, schema, contrato público, dependência, workflow ou operação externa relevante.

Exemplos: correção editorial inequívoca, teste ausente para comportamento já definido ou ajuste local sem mudança de contrato.

### Normal

Mudança com comportamento ou governança novos, múltiplos arquivos ou coordenação relevante, mas sem gatilho Critical. O contrato é conhecido e a reversão continua controlável.

Exemplos: documentação operacional transversal, refatoração interna dentro de arquitetura aceita ou automação local não destrutiva.

### Critical

Mudança que afeta uma fronteira de confiança, dados, disponibilidade, contrato difícil de reverter ou operação externa sensível. Exige arquitetura e verificação independentes.

## Gatilhos Critical

Qualquer item abaixo classifica a tarefa como Critical:

- autenticação, autorização, sessão, segredo ou credencial;
- isolamento multi-tenant, ownership ou privilégio;
- migration, schema, integridade, retenção, exclusão ou transformação de dados;
- contrato público incompatível, endpoint privilegiado ou integração externa com efeito real;
- produção, deploy, release, infraestrutura compartilhada ou configuração de segurança;
- dependência nova com impacto de runtime ou supply chain;
- operação irreversível ou com risco material de indisponibilidade/perda;
- conflito com ADR aceito ou decisão arquitetural difícil de reverter;
- finding médio de segurança, tenant, dados, schema, API ou ownership;
- requisito ambíguo que possa alterar uma dessas fronteiras.

## Gates

### Gate 1 — Arquitetura aprovada

O Product Owner e, quando aplicável, o responsável técnico aprovam classe, escopo, contratos, alternativas, riscos, ownership e validação antes da implementação.

É obrigatório para Critical e para qualquer tarefa com decisão arquitetural ou de produto nova. Pode ser dispensado como etapa separada em Simple e em Normal quando um ADR ou padrão aceito já determina inequivocamente a solução; a justificativa deve constar no handoff inicial.

### Gate 2 — Implementação aprovada

O diff está estável, o verifier concluiu a revisão exigida, todos os findings bloqueantes foram resolvidos e reverificados, a documentação está coerente e as validações proporcionais passaram. Uma interrupção bloqueia Gate 2 até que exista decisão ou replanejamento e nova verificação. Gate 2 autoriza a preparação da entrega remota somente quando a tarefa também conceder essa operação.

### Gate 3 — Merge autorizado

O Product Owner autoriza explicitamente o merge depois de Pull Request, CI, feedback e estado final serem conhecidos. Gate 3 não é presumido pelo sucesso da CI nem por autorização anterior de commit ou push.

## Matriz mínima

| Classe   | Papéis mínimos                                                                                                            | Gates                                                               | Validação mínima                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Simple   | coordenador, builder e verifier por checklist podem ser acumulados de forma declarada; operador somente quando autorizado | Gate 1 separado dispensável; Gate 2 proporcional; Gate 3 para merge | checks focados no diff e validações estáticas aplicáveis                                                         |
| Normal   | coordenador e builder; verifier separado ou etapa lógica independente; operador quando autorizado                         | Gate 1 quando houver decisão nova; Gates 2 e 3                      | checks focados, build e suítes afetadas; CI no PR                                                                |
| Critical | coordenador, builder, verifier independente e operador autorizado                                                         | Gates 1, 2 e 3 obrigatórios                                         | validação completa aplicável, casos adversariais, segurança e CI; migration, integração e Docker quando afetados |

As responsabilidades detalhadas e as regras de acumulação de papéis estão no [modelo operacional](MULTI_AGENT_OPERATING_MODEL.md).

## Elevação e reclassificação

- Eleve imediatamente quando surgir um gatilho Critical, expansão material ou dependência não prevista.
- Interrompa antes de continuar sob uma classe mais alta; atualize escopo, owners, gates e validação.
- Não reduza a classe durante a implementação apenas porque o diff ficou pequeno.
- Uma redução posterior exige nova avaliação do coordenador e não elimina gates já abertos sem aprovação.
- Finding preexistente fora do escopo deve ser registrado separadamente; se bloquear segurança ou validade da tarefa, interrompe o trabalho.

## Arquitetura separada

Uma etapa de arquitetura separada pode ser dispensada somente quando todas as condições forem verdadeiras:

- tarefa Simple ou Normal;
- nenhum gatilho Critical;
- decisão coberta por ADR, contrato ou padrão vigente;
- nenhuma decisão de produto ausente;
- ownership, rollback e validação são inequívocos;
- o coordenador registra a justificativa.

Se qualquer condição falhar, Gate 1 deve ocorrer antes da escrita.
