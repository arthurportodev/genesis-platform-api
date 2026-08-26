# ADR-019 — Valor esperado da oportunidade no ciclo comercial de Lead

- **Status:** Proposed — candidato para Gate 1
- **Data:** 2026-08-25

## Contexto

O Pipeline Experience V2 precisa tornar dinheiro uma informação comercial de
primeira classe: cada oportunidade deve poder apresentar valor esperado, cada
estágio deve apresentar o total correspondente e o Pipeline deve oferecer um
resumo financeiro completo. O domínio de Leads não possui atualmente campo,
comando, histórico ou agregado monetário.

O modelo vigente identifica o Lead por Organization e telefone e mantém no
Lead o snapshot operacional atual. Cada período ativo possui exatamente um
`LeadCommercialCycle`; ciclos fechados preservam o histórico e a reativação
abre um novo ciclo. O produto não precisa, no horizonte atual, de oportunidades
simultâneas independentes para o mesmo contato.

Dinheiro exige unidade e transporte inequívocos, distinção entre ausência e
zero, autorização no backend, concorrência segura e histórico. A soma exibida
no Kanban não pode depender das páginas de cards carregadas.

## Decisão

### Significado e ownership

`expectedValue` significa o valor esperado da oportunidade comercial corrente.
Não significa valor contratado, receita realizada, pagamento recebido ou
confirmação financeira. Esses conceitos, se surgirem, terão nomes, regras e
persistência próprios.

O valor esperado pertence a `LeadCommercialCycle`, não ao `Lead` durável. O
Lead continua sendo a identidade comercial e raiz operacional; o ciclo aberto
é a representação conceitual da oportunidade atual. Não será introduzida agora
uma nova hierarquia `Contact → Lead → Opportunity → Deal`.

A limitação aceita é que uma Organization não pode manter duas oportunidades
ativas e independentes para a mesma identidade de Lead. Caso esse requisito
surja, uma nova decisão de domínio deverá avaliar uma entidade Opportunity
explícita sem reinterpretar ciclos históricos.

### Moeda, persistência e transporte

A moeda desta fase é somente BRL. Não haverá coluna de moeda por Lead ou ciclo.
Evolução para multi-currency exige novo ADR e migration; não pode reinterpretar
valores históricos implicitamente.

Cada ciclo armazenará `expected_value_minor` como `bigint` nullable em centavos
de real, com constraint de valor maior ou igual a zero. `null` significa valor
não informado; `0` significa valor explicitamente informado como zero. Valores
fracionários de centavo, negativos, `NaN`, infinito e formatos exponenciais não
são válidos.

Contratos HTTP representarão valor individual e totais como string decimal
canônica de inteiros não negativos. O campo de projeção será
`expectedValueMinor: string | null`; a moeda será declarada como o literal
`BRL` nas respostas financeiras. O backend validará o valor individual contra
a faixa de `bigint`. Clientes não converterão esse campo para `number` antes de
formatar ou operar, inclusive acima de `Number.MAX_SAFE_INTEGER`.

Totais também usam string decimal. PostgreSQL agrega `bigint` como `numeric`,
portanto o total não será artificialmente limitado à faixa de um valor
individual.

### Criação, atualização e lifecycle

Um Lead criado sem valor abre seu primeiro ciclo com
`expected_value_minor = null`. Quando o fluxo manual/quick create futuro
fornecer valor e a operação realmente criar o Lead e seu primeiro ciclo, esse
valor poderá ser aplicado atomicamente ao ciclo novo.

Quando a criação/ingestão corresponder a um Lead existente, ela não altera o
valor do ciclo atual, mesmo que uma nova Entry seja criada. O fluxo deve tratar
essa resposta segundo a semântica já existente de Lead novo, Lead existente ou
resultado opaco. Alterar o valor de uma oportunidade existente exige comando
comercial explícito posterior; não é efeito colateral de deduplicação ou
intake.

Um comando explícito de definição do valor atua somente no ciclo aberto de um
Lead ativo e aceita um inteiro não negativo ou `null`. Uma mudança efetiva:

- revalida Organization, membership, papel, visibilidade e responsabilidade;
- exige a revisão corrente pelo contrato condicional existente;
- participa do mecanismo versionado de idempotência quando o comando puder ser
  repetido após resultado remoto incerto;
- incrementa a revisão do Lead exatamente uma vez;
- atualiza o ciclo e insere o evento histórico na mesma transação.

Definir novamente o mesmo valor, inclusive `null`, é no-op: não incrementa
revisão nem cria evento. Fechar o Lead preserva o valor final no ciclo fechado e
o torna histórico imutável. Reativar abre um novo ciclo com valor `null`; o
valor do ciclo anterior nunca é copiado automaticamente.

### Autorização e concorrência

Não existe autorização financeira paralela ou decidida pela UI. Owner e admin
continuam sujeitos às capacidades tenant-scoped existentes. Member só pode
alterar valor quando o Lead está ativo, visível e atribuído à sua membership,
nas mesmas condições de autoridade por recurso usadas pelos comandos
comerciais atuais. Lead fechado e ciclo histórico não podem ter valor editado.

A autoridade final permanece no backend e na função transacional. Guardas de
rota não substituem a revalidação dentro da transação. A implementação futura
preservará a ordem de locks, `If-Match`, revisão, fingerprint HMAC e
idempotência já usados pelo lifecycle. O endpoint e DTO futuros não poderão
aceitar moeda enviada pelo cliente nesta fase.

### Histórico

Toda definição explícita que altere o estado, inclusive um valor inicial não
nulo aplicado à criação de um ciclo novo, produzirá evento tipado append-only
na timeline. O evento preservará referência do ciclo e snapshots escalares do
valor anterior e novo em centavos; `null` é permitido em qualquer lado. Não
será armazenado payload monetário livre ou formatado.

O ciclo fechado preserva seu último valor. A timeline explica quem alterou,
quando, em qual ciclo e qual foi a transição, sem depender do valor corrente do
Lead ou de formatação do frontend.

### Agregação financeira do Kanban

`GET /api/v1/leads/kanban` será estendido de forma aditiva. O mesmo snapshot de
leitura autorizado e o mesmo conjunto filtrado usado por cards e contagens
calcularão:

- soma dos valores conhecidos por estágio;
- quantidade de oportunidades sem valor por estágio;
- soma dos valores conhecidos em todo o Pipeline;
- quantidade total de oportunidades sem valor no Pipeline;
- moeda `BRL`.

`null` não contribui para a soma, mas é contado separadamente. Assim, zero
agregado não afirma silenciosamente que todas as oportunidades valem zero. Os
totais cobrem todo o conjunto filtrado e visível, independentemente do limite,
cursor ou páginas carregadas. Continuação de uma coluna não altera a definição
do agregado.

O cálculo pertence ao backend, no mesmo read model tenant-scoped, sem somar
cards no cliente, sem N+1 e sem reutilizar o endpoint de métricas administrativas
com semântica e autorização diferentes. Novos índices só serão adicionados com
evidência de plano de execução.

### Rollout compatível

O rollout será API-first e aditivo:

1. migration, persistência, comando, timeline e testes backend;
2. projeções de detalhe/lista e agregado Kanban;
3. consumo frontend dos novos campos;
4. quick create com valor somente depois do contrato financeiro disponível.

Leads e ciclos existentes recebem `null`; nenhum backfill monetário é
inventado. Clientes antigos continuam válidos enquanto ignorarem campos de
resposta adicionais. Tornar um novo campo obrigatório no frontend só ocorre
depois da API compatível estar disponível.

## Alternativas consideradas

- **Valor no Lead:** rejeitado porque sobrescreve a distinção entre ciclos
  sequenciais e torna o histórico ambíguo.
- **Nova entidade Opportunity agora:** rejeitada por custo transversal sem
  requisito de oportunidades simultâneas.
- **`float`/`double`:** rejeitado por não representar dinheiro de forma exata.
- **Decimal formatado ou reais no HTTP:** rejeitado por ambiguidade de escala,
  locale e precisão entre clientes.
- **Multi-currency agora:** rejeitado porque BRL-only está aprovado e a
  complexidade não atende requisito atual.
- **Soma das páginas no frontend:** rejeitada porque produz total parcial
  apresentado como completo.
- **Reuso do endpoint de métricas:** rejeitado por diferença de escopo temporal,
  filtros e autorização.
- **Ingestão atualizando valor existente:** rejeitada porque transforma entrada
  de aquisição em decisão comercial implícita.

## Consequências

- Uma migration aditiva futura será necessária para o ciclo e o histórico.
- DTOs, tipos de resposta, comando, fingerprint, função transacional, timeline,
  read model Kanban e testes terão impacto.
- O frontend precisará de formatação monetária baseada em string e não poderá
  derivar totais de páginas.
- O domínio distingue explicitamente valor esperado de receita e pagamento.
- Ciclos sequenciais continuam suficientes e preservam valores históricos.
- BRL-only reduz complexidade agora, mas multi-currency exigirá evolução
  explícita e não automática.
- Este ADR não implementa schema, comando, endpoint, migration ou contrato de
  runtime.

## Relações

- Complementa o [ADR-005 — Autorização por papel](ADR-005-role-based-authorization.md).
- Especializa o [ADR-008 — Lifecycle comercial de Leads por estado atual e ciclos imutáveis](ADR-008-lead-commercial-lifecycle.md) sem substituir seu modelo de ciclo, locks, revisão ou idempotência.
- Complementa o [ADR-009 — Activities, Notes e Next Action tipadas](ADR-009-lead-activities-follow-up.md) quanto ao padrão de histórico tipado e append-only.
- A apresentação e interação frontend são decididas no ADR Web correspondente
  do Pipeline Experience V2.

## Implementação

Não implementado. Este documento é candidato de arquitetura para Gate 1. A
primeira tarefa autorizável depois da aprovação é a persistência e o comando do
valor esperado em `LeadCommercialCycle`, exclusivamente no backend.
