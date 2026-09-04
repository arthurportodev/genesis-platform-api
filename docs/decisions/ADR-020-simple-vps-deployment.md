# ADR-020 — Deploy simples da API em VPS

- Estado: Accepted
- Data: 2026-09-03
- Decisão: `SIMPLE_VPS_DEPLOYMENT`
- Supersede: ADR-018 para novos deploys da API

## Contexto

A Genesis opera uma VPS e uma única réplica pública da API. O contrato anterior
adicionou release-tree, bundles current/rollback, staging, quarentena e troca de
árvore para resolver um incidente específico de integridade. Esses mecanismos
permanecem históricos, mas são desproporcionais ao deploy normal desse runtime.

## Decisão

Novos deploys usam um diretório operacional fixo em `/opt/genesis/deploy`,
Docker Compose e um único operador Python. Docker é a autoridade para container,
imagem factual, health e restart count; PostgreSQL/TypeORM é a autoridade para
migrations; Compose é a autoridade de topologia. O arquivo root-only
`/opt/genesis/config/api-image.env` contém apenas a imagem desejada por digest e
nunca substitui a inspeção do runtime.

Um `operational-integrity.json` vincula o `operationalSourceSha` aprovado
externamente no Gate A e a allowlist exata de arquivos operacionais aos
respectivos SHA-256 e modes. Sua geração exige um checkout Git limpo exatamente
naquele commit. Ele comprova os bytes do mecanismo de deploy, não cria outra
identidade de release. O `applicationSourceSha`, também fornecido externamente,
é separado e deve coincidir com a revisão OCI da imagem candidate. Configuração
host-specific não secreta fica em `production.env`, com chaves, valores, hash e
mode exatos. Secrets continuam file-backed e fora do Git.

Compose sempre recebe projeto `genesis`, project directory fixo, primeiro
`production.env`, depois `api-image.env`, e arquivos absolutos em ordem fixa. O
ambiente filho remove chaves de configuração, `API_IMAGE`, controles Compose e
seletores Docker herdados; `API_IMAGE` é obrigatória e somente
inventário/migration do candidate recebe a imagem validada por injeção
deliberada. Promoção e rollback consomem exclusivamente o pointer canônico.

O operador usa um único `flock` não bloqueante. O preflight consulta um lock
existente sem criá-lo; somente a execução já autorizada pode criá-lo. Todo
subprocesso possui timeout fixo por categoria. Antes de qualquer promoção ele
prova a imagem anterior e o candidate por RepoDigest e `linux/amd64`; o candidate
também deve declarar a revisão OCI igual ao application source SHA e possuir
evidência externa de release aprovada, incluindo os dois source SHAs e a lista
Level 2 autorizada. Divergência
pointer/runtime termina em STOP. A atualização do
pointer usa temp no mesmo diretório, `fsync(file)`, `os.replace` e
`fsync(directory)`, sem journal ou estado intermediário próprio.

## Níveis

- Level 1 exige `pending=[]`, atualiza o pointer e recria somente a API.
- Level 2 exige o pending exato previamente aprovado como backward-compatible,
  checkpoint pelo recovery existente, migration one-shot e inventário final
  exatamente igual ao inventário anterior concatenado ao pending aprovado.
- Level 3 não possui fluxo genérico e exige arquitetura separada.

O operador confirma que os IDs de PostgreSQL e Traefik não mudaram. Nunca chama
`migration:revert` e nunca recria banco ou edge durante promoção/rollback.

## Health, smoke e observation

Health técnico interno usa Docker `/health`; o único health direto externo é
`GET https://api.agenciagenesismkt.com.br/health`. O smoke funcional usa apenas
`https://app.agenciagenesismkt.com.br`: CSRF, login, bootstrap, organização
retornada, Kanban e logout. Tokens, cookies, credentials e payloads de cliente
não entram em logs ou evidence.

Level 1 observa T+0/T+30/T+120; Level 2 observa T+0/T+60/T+300. Cada checkpoint
confirma digest, health, restart count, IDs das dependências, ausência de 5xx
por parsing estrutural de `DownstreamStatus` no JSON do Traefik, logs
sanitizados e smoke mínimo.

## Rollback e evidence

Depois de uma promoção falha, o operador preserva a primeira causa, regrava o
pointer anterior, recria somente a API e confirma digest, health e smoke de
compatibilidade. O schema não é revertido. Falha do rollback mantém a causa
original, registra razão separada e exige escalação.

Evidence é um JSON progressivo root-only em
`/var/lib/genesis/deploy/evidence/<runId>.json`, reescrito atomicamente com a
mesma sequência de durabilidade do pointer. É auditoria, não autoridade de
runtime nem estado de workflow. Depois da promoção, indisponibilidade dessa
auditoria não pode impedir rollback: a primeira causa e o resultado ficam em
memória, o runtime é restaurado sem novas escritas de evidence e só então há
uma tentativa best-effort de persistir o estado terminal.

## Complexidade e autorização

Não existem state machine persistente, release-tree nova, bundle, staging,
quarentena, segundo pointer ou fingerprint agregado. A autorização de mutação é
uma confirmação explícita vinculada a run ID, application source SHA,
operational source SHA, candidate digest e level. Aprovação externa do
candidate, dos bytes operacionais e do CI (Gate A) não substitui autorização de
produção (Gate B).

## Transição do mecanismo

- **Fase A — implementação:** o novo operador e o novo contrato Compose são
  implementados e testados somente no repositório. O harness anterior permanece
  preservado no Git e na história para auditoria, mas passa a ser
  **legacy / unsupported for new deploys** quando este contrato Compose/pointer
  é introduzido. Ele não precisa renderizar os novos bytes.
- **Fase B — Git delivery:** depois do Gate 2, commit, CI, PR e merge podem
  ocorrer em tarefa autorizada, ainda sem mudança no runtime de produção.
- **Fase C — primeiro deploy simples:** uma tarefa operacional futura descobre
  o digest factual pelo Docker, prova a imagem anterior imutável, local ou
  pullable, com RepoDigest e `linux/amd64` corretos, instala
  `/opt/genesis/deploy`, inicializa o pointer com esse digest, prova
  pointer/runtime, executa o novo preflight, obtém Gate B e só então promove.
- **Fase D — rollback:** uma falha na primeira promoção usa exclusivamente o
  novo fluxo `previous digest -> pointer -> API-only recreate -> health`. O
  rollback não depende do harness anterior.
- **Fase E — legacy:** depois do primeiro deploy simples bem-sucedido, o harness
  anterior pode permanecer no repositório até uma tarefa futura e separada de
  cleanup; sua presença não cria um segundo mecanismo suportado.

Antes da primeira promoção, o rollback do mecanismo novo deve ter sido provado
em rehearsal ou ambiente descartável, e API, PostgreSQL e Traefik devem estar
healthy. Nenhuma mutação do candidate pode ocorrer antes de todas as provas. Se
a imagem anterior não puder ser provada, o resultado é `STOP BEFORE MUTATION`.
A produção permanece intocada até essa tarefa operacional futura.

## Consequências

O fluxo normal fica menor e diagnosticável, com um mecanismo de deploy, um
pointer e um rollback suportados. O recovery compartilhado permanece disponível
quando invocado pelo novo Level 2; o harness de release-tree fica somente como
registro histórico e não é fallback operacional. Instalação e primeira execução
reais exigem tarefa operacional e Gate B próprios. Cleanup do harness histórico
é uma decisão futura e não bloqueia este objetivo.

## Implementação

- `compose.production.yml`
- `docker/production/deploy-api-simple.py`
- `test/production/deploy-api-simple.test.py`
- `test/production/deploy-api-simple-linux.test.cjs`
- [procedimento operacional](../PRODUCTION.md#deploy-simples-da-api)
