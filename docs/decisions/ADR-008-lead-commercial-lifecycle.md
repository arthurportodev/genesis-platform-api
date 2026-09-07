# ADR-008 — Lifecycle comercial de Leads por estado atual e ciclos imutáveis

- **Status:** Accepted
- **Data:** 2026-07-27

## Contexto

A fundação 0.3.1 identifica um Lead por tenant e telefone, preserva cada Entry e oferece inbox, edição básica e assignment. O pipeline precisa acrescentar movimentação, fechamento e reativação sem apagar contexto histórico. Novas Entries também podem chegar depois do fechamento e não devem reabrir ou reatribuir o Lead implicitamente.

O lifecycle é concorrente: intake, comandos, assignment e offboarding podem disputar o mesmo recurso. A role de runtime não possui DML direto nas tabelas CRM, e idempotência precisa sobreviver a retry, rotação de chave e resposta perdida.

## Decisão

`Lead` conserva o snapshot atual de `status`, `stage`, revisão e próximo número de ciclo. Cada período ativo possui um `LeadCommercialCycle`: exatamente um ciclo fica aberto enquanto o Lead está ativo e nenhum fica aberto quando ele está encerrado. Fechamentos completam o ciclo sem alterar o estágio; reativação abre um novo ciclo em `qualification`.

Uma Entry recebida para Lead encerrado preserva lifecycle e assignment. Ela abre ou agrega o único `LeadReturnReview` pendente daquele Lead. A revisão termina explicitamente como `reactivated` ou `dismissed`; reativação continua disponível mesmo sem revisão pendente.

Os seis comandos de lifecycle atravessam `app_private.execute_lead_command`, com locks na ordem Organization → Users ordenados → Memberships ordenadas → Lead → claim → Cycle → ReturnReview → Timeline. A função revalida autorização, usa `If-Match`, claim por UUID v4 e fingerprint HMAC versionado e retorna somente revisão, replay e status `204`.

Ciclos e revisões são protegidos contra reescrita histórica por checks e triggers. Constraint triggers diferidos verificam a cardinalidade de ciclos abertos no commit. A timeline continua append-only e ganha colunas tipadas para estado, estágio, motivo, ciclo e revisão.

## Alternativas consideradas

- Sobrescrever apenas status e estágio no Lead: recusado porque perde o histórico de ciclos e os motivos de cada fechamento.
- Reabrir automaticamente ao receber nova Entry: recusado porque converte intake em decisão comercial implícita e cria disputa com assignment.
- Modelar cada estágio como registro ou transição rígida: recusado no MVP; o produto aprovou movimentação livre entre cinco estágios enquanto ativo.
- Conceder DML das novas tabelas ao runtime: recusado para preservar a fronteira transacional e a ordem de locks.

## Consequências

- Fechamento, auditoria tipada, ciclo e revisão são atômicos e reexecutáveis com segurança.
- O modelo acumula histórico imutável e exige rollback fail-closed depois do primeiro dado de lifecycle.
- Mover para o mesmo estágio é no-op idempotente sem revisão ou evento novo.
- O intake externo continua implementado, fail-closed e não habilitado operacionalmente; esta decisão não configura relay, segredo ou produção.
- Atividades, notas livres, busca e métricas continuam fora do escopo.

## Relações

- Complementa o [ADR-002](ADR-002-multi-tenant-strategy.md).
- Complementa o [ADR-005](ADR-005-role-based-authorization.md).
- Depende da fundação de Leads entregue na Tarefa 0.3.1.

## Implementação

Implementado como candidato local da Tarefa 0.3.2 pela migration aditiva `1785433200000-ManageLeadCommercialPipeline.ts`, pelas entidades e endpoints do `LeadsModule` e pelos testes PostgreSQL e E2E correspondentes.

## Revisão — PIPE-V2-06 Fase A (2026-09-07)

A autoridade futura de posição comercial passa do enum fixo para `Pipeline` e
`PipelineStage`, ambos tenant-scoped. O enum e suas colunas permanecem como
ponte de compatibilidade durante o rollout API-first; não são removidos nesta
fase.

O `LeadCommercialCycle` continua sendo a associação histórica autoritativa com
o processo. Ele referencia Pipeline e Stage por UUID e preserva snapshots dos
nomes na abertura e no fechamento. A timeline também preserva IDs e nomes nos
eventos de transição, portanto renomear um Stage muda a apresentação atual sem
reescrever o passado.

`Lead` mantém somente o snapshot operacional atual e agora admite zero ou um
ciclo aberto. Um Lead `active` sem ciclo usa `pipeline_id = null` e
`pipeline_stage_id = null`; com ciclo aberto, os dois IDs coincidem com o
ciclo. Leads terminais não têm ciclo aberto nem snapshot corrente. O início
explícito de ciclo seleciona um Pipeline e usa seu primeiro Stage ativo. Para
um Lead já ativo registra apenas `lead.cycle.started`; para um Lead terminal
preserva `lead.reactivated`.

Transições sequenciais entre Pipelines encerram um ciclo e abrem outro. O mesmo
ciclo não muda de Pipeline, e um Lead não participa simultaneamente de mais de
um processo no MVP. A API legada de criação, movimento e Kanban permanece
disponível até a Fase Web da mesma iniciativa; a revisão correspondente do
ADR-013 fica pendente para essa fase.

Durante essa ponte, os cinco Stages do Pipeline default mantêm slots posicionais
estáveis para o enum legado. Rename é permitido, mas create, reorder e archive
desses slots são recusados até a remoção da ponte; Pipelines customizados não
têm essa restrição. O contrato nullable de Lead sem ciclo exige o opt-in
`X-Genesis-Lead-Contract: pipeline-v2`; sem ele, coleções legadas omitem esses
Leads e detail/timeline/cycles não expõem shapes incompatíveis ao Web atual.
