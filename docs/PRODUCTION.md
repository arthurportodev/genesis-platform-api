# Produção do MVP

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

Este documento define contratos e runbooks duráveis. Toda afirmação datada de
execução abaixo é evidência histórica, não estado live. Fase, operação atual,
gates, blockers e decisões pendentes são resolvidos exclusivamente em
`docs/memory/project-state.v1.json`.

Este documento é a autoridade operacional da primeira produção da Genesis
Platform. A decisão arquitetural está no
[ADR-013](decisions/ADR-013-mvp-production-baseline.md). O objetivo é publicar o
produto existente para testes reais com segurança proporcional ao MVP, sem
antecipar uma infraestrutura definitiva.

<!-- genesis-memory-history:start -->

## Snapshot histórico da incorporação 05A/05B

O contrato versionado de PostgreSQL, secrets e bundle está no
[ADR-014](decisions/ADR-014-versioned-production-contract.md). A
`0.8-MVP-05A` foi incorporada pelo PR #35 no squash
`5268706d22cb69df7d065928c16b4425a03b41cf`. O contrato está versionado na
`main`. A `0.8-MVP-05B` instalou e verificou a baseline privada desse contrato
na VPS a partir do commit
`38baf1e8898194b618cfee787a3bea753677eb93`, sem exposição pública nem dados
reais.

<!-- genesis-memory-history:end -->

## Objetivo

Operar uma instância pequena, compreensível e recuperável do frontend, da API e
do PostgreSQL. A abertura para usuários exige os controles mínimos deste
documento; requisitos avançados permanecem no backlog pós-MVP.

## Contrato, execução histórica e runtime

Este runbook define o procedimento durável. A execução histórica bem-sucedida
da 09E promoveu a imagem
`ghcr.io/arthurportodev/genesis-platform-api@sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb`
e preservou
`ghcr.io/arthurportodev/genesis-platform-api@sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a`
como rollback. O resultado foi `TASK_09E_DEPLOYED_AND_OBSERVED`, sem migration,
e API, PostgreSQL e Traefik terminaram saudáveis.

A imagem live deriva da application revision
`0a56a8aee7c64bda59a1981888418e1ad03950c0`; o API `main`
`f5a11c6ad5b6f4817198730b8311d27117ee01a7` adiciona o tooling privado de
onboarding posterior e não é a revisão fonte do runtime implantado. O estado
temporal completo, inclusive digests vigentes, continua na
[memória canônica](memory/project-state.v1.json).

O script exato executado na 09E tem SHA-256
`e99dee6fb4610f9ca470aca8e12f00c4076e60ea45de3f9fb7a4f762208b6db6`
e está preservado sob custódia operacional externa em
`0.8-MVP-09E/deployment-execution/deploy-api-digest.sh`. Esse artefato não está
comprovadamente versionado na `main`; a branch operacional local e suas
modificações posteriores não são o procedimento oficial. Antes de qualquer
futuro deployment da API, o procedimento deve ser reconciliado, revisado e
versionado novamente, com nova autorização humana. Essa lacuna de
rastreabilidade futura não representa incidente no runtime atual.

<!-- genesis-memory-history:start -->

## Snapshot histórico da baseline incorporada

O runtime health, a rebaseline documental e o container/Compose de produção
foram incorporados pelos PRs #29 e #31. A CI essencial e a publicação GHCR
foram incorporadas pelo PR #32 no squash
`c02af719c72277f49348de33762ff12dc589434d`. A correção de identidade remota e
evidências foi incorporada pelo PR #33 no squash
`c6fbc0b865540abd9d13f93c7cc7542eb0936355`; a execução pós-merge
`31249557339` aprovou validação, runtime, scan local, push, identidade remota,
package público, rescan por digest e artifact. Isso comprova imagens públicas,
a proveniência da imagem, não a abertura de produção. A VPS Hostinger KVM 2
agora hospeda a baseline privada instalada pela `0.8-MVP-05B`: Docker,
PostgreSQL, volume persistente, migrations, secrets e API foram comprovados sob
os controles aprovados. DNS, origem pública, Vercel, Traefik, HTTPS, backup,
restore, monitoramento e smoke de abertura permanecem não executados ou não
comprovados. Nenhum dado real está autorizado.

O host aprovado é `srv1870064` (`147.79.82.44`), Ubuntu 24.04.4 LTS. O boot ID
vigente após o Checkpoint B é
`1203958f-2ae3-448c-83c1-349b0bb952d8`. Docker, SSH, UFW, fail2ban, AppArmor e
swap persistiram, com zero unidade crítica falhada e Web Terminal funcional.

O target `production` do Dockerfile e `compose.production.yml` definem a stack
base incorporada pela `0.8-MVP-03`. A imagem foi publicada somente no GHCR e a
stack foi validada em Docker Desktop com dados sintéticos antes da operação. A
05B implantou apenas a baseline privada aprovada na VPS; isso não autoriza dados
reais. `compose.yml` e
`compose.test.yml` permanecem superfícies separadas de desenvolvimento e teste.

A `0.8-MVP-05A` preservou a imagem já publicada da API e alterou apenas
artefatos não image-affecting. Ela versiona o contrato necessário antes da
instalação: três roles PostgreSQL, secrets file-backed, imagens por digest,
identidade estável do projeto/volume e bundle mínimo. O PR #35 foi incorporado
em `2026-08-09T00:39:02Z` (`2026-08-08T21:39:02-03:00`), e a CI pós-merge
`31286630732` foi aprovada. O detector retornou `shouldPublish=false`, o job
`publish-image` permaneceu `skipped`, nenhuma tag nova foi criada e o digest da API
`sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659`
foi preservado. Nada foi transferido à VPS e nenhum volume, secret ou serviço
persistente foi criado.

<!-- genesis-memory-history:end -->

## Arquitetura

```text
Navegador
→ frontend na Vercel em app.agenciagenesismkt.com.br
→ proxy same-origin de /api/v1
→ API oficial em api.agenciagenesismkt.com.br
→ Traefik
→ uma instância da API NestJS
→ PostgreSQL 17 em rede privada
```

O navegador usa apenas paths relativos `/api/v1`. Preview não recebe a origem
de produção e falha fechado. Somente o Traefik publica a origem; as portas da
API e do PostgreSQL não possuem exposição direta. Forwarded headers e
`TRUST_PROXY_HOPS` serão ajustados e testados contra a topologia real.

Esses hostnames, Vercel e Traefik são destinos aprovados, não evidência de DNS,
TLS, deploy ou operação live. O ambiente inicial aprovado é somente produção,
sem staging.

<!-- genesis-memory-history:start -->

## Snapshot histórico dos serviços da baseline privada

A VPS Hostinger KVM 2 dedicada, com 2 vCPU, 8 GB de RAM e 100 GB NVMe, foi
inventariada e validada para o escopo privado da `0.8-MVP-05B`. Docker está
instalado e persistente; PostgreSQL 17 e API NestJS estão running e healthy
somente nas redes internas, sem portas publicadas. O volume
`genesis-postgres-data`, as dez migrations e a readiness persistiram, e os dois
serviços recuperaram-se automaticamente após o reboot controlado.

Isso comprova somente a baseline privada: externamente permanece acessível
apenas TCP/22, com TCP/80 e TCP/443 bloqueadas. Proxy reverso, TLS, exposição
controlada, domínio/DNS e os respectivos gates de abertura continuam pendentes;
a VPS não está pronta para produção.

| Serviço       | Responsabilidade                                     | Estado                                                                                                  |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| VPS Hostinger | hospedar a stack mínima do MVP                       | inventariada e endurecida; Docker e baseline privada validados; não pronta para produção                |
| Vercel        | frontend e proxy same-origin de `/api/v1`            | frontend/proxy de produção ainda não configurados nem comprovados                                       |
| Traefik       | HTTPS e único ingresso público da origem             | ainda não implantado; proxy reverso, TLS e exposição pública permanecem pendentes                       |
| API NestJS    | contratos de sessão, tenant, CRM e runtime health    | implantada internamente; running/healthy, readiness `4/4`, sem porta publicada e recuperada após reboot |
| PostgreSQL 17 | persistência privada, roles e migrations             | implantado internamente; running/healthy, volume e dez migrations persistentes, sem porta publicada     |
| Backup        | cópia recuperável separada da persistência principal | não configurado nem comprovado nesse snapshot                                                           |
| Monitoramento | uptime, recursos, logs, health e backup              | não configurado nem comprovado nesse snapshot                                                           |

<!-- genesis-memory-history:end -->

Redis, n8n, Evolution API, Portainer e outros serviços só entram quando uma
funcionalidade do MVP demonstrar dependência real. A primeira topologia usa
uma réplica da API enquanto rate limits e semáforos forem process-local.

### Container e Compose versionados

A stack base possui somente `postgres`, `migrate` e `api`, sob o projeto fixo
`genesis`. O Compose versionado representa o role prospectivo `current` e usa
para API e migration a imagem candidata publicada, ainda não implantada,
`ghcr.io/arthurportodev/genesis-platform-api@sha256:c53b283571955fa4ad2a056270bbc4b03222028e56d5177208c1a788696149f7`;
PostgreSQL usa o índice oficial
`postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`,
cuja variante `linux/amd64` é
`sha256:af194ccf3e2d7fe367012c7b88ce8b816c5c889b18a5b316799a1f0d7eac746a`.
Tags e `build:` são proibidos. A API e o PostgreSQL não publicam portas; a API
declara apenas exposição interna na porta 3000.

Esse binding versionado distingue a identidade da aplicação, a identidade OCI
e o containing commit do release. O role prospectivo `current` liga a
application revision `ac2f8cd96ae02c1cad52366871bdde8ca651631d` ao manifest
digest `sha256:c53b283571955fa4ad2a056270bbc4b03222028e56d5177208c1a788696149f7`
e ao config digest
`sha256:17e5b82451b78a20c6934b5dc2bb0cc00fa10252665245ed49b2f7c09a7fc629`.
O rollback imediato do próximo deployment é a aplicação atualmente live:
revision `0a56a8aee7c64bda59a1981888418e1ad03950c0`, manifest digest
`sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb`
e config digest
`sha256:1cd0615209cd0ac5b00b9b89754d525a1af9eead3d727f3397a98bfe33d08b24`.
Ambos os bundles `committed-release` usam o mesmo future containing commit como
`sourceCommit`; esse SHA não é a `applicationRevision` de nenhuma imagem.

O antigo digest `a4dafefa...` continua válido em registros históricos, e
`56ada3e6...` conserva sua função independente no tooling de recovery. Nenhum
deles compõe o próximo par current/rollback. Incorporar este contrato
versionado, isoladamente, não faz deploy, migration ou acesso ao banco; o
runtime live continua registrado separadamente acima e na memória canônica.

O PostgreSQL usa o volume externo `genesis-postgres-data`, que deve existir
antes do `up` e não é removido por `docker compose down -v`. Bootstrap/admin,
migration owner e runtime são roles distintas. A migration é owner do database
e schema `public`, sem privilégios administrativos; runtime não tem ownership,
membership ou DDL. Privilégios de `PUBLIC` são revogados, e as migrations
continuam responsáveis pelos grants funcionais do runtime. Init scripts rodam
somente no primeiro volume vazio; rotação posterior usa operação explícita.

O job de migration é one-shot, chama diretamente o TypeORM compilado e bloqueia
a API quando falha. `migration:revert` não é rollback operacional. A API usa filesystem read-only,
UID/GID fixos não-root, init, capabilities removidas, `no-new-privileges`,
readiness explícita e shutdown com tolerância externa de 20 segundos.
PostgreSQL recebe 90 segundos para shutdown.

Secrets são arquivos individuais sob `/opt/genesis/secrets`, futuros
`root:genesis-container-secrets` (`0440`, GID 70). Compose monta somente o
subconjunto de cada serviço. API e migration recebem GID suplementar 70 e
wrappers POSIX read-only carregam os nomes de ambiente já validados antes de
um `exec`; valores não entram em Compose `environment`, `.env`, metadata,
argumentos, logs, manifestos ou Git. O bootstrap usa
`POSTGRES_PASSWORD_FILE`. `LEAD_IDEMPOTENCY_KEYS` é montado somente na API e a
versão corrente não secreta permanece `1`. Invitations e Lead Form continuam
fail-closed.

O candidato `0.8-MVP-08` fixa
`FRONTEND_URL=https://app.agenciagenesismkt.com.br`, origem única e sem
wildcard. O Compose base continua health-only e define
`WEB_PROXY_ATTESTATION_ENABLED=false`; o override funcional versionado é
aditivo, futuro e não pode ser aplicado sem Gate operacional.

A rede `edge` conecta API e Traefik sem publicar a porta 3000. O provider de
arquivos observa apenas `/run/traefik/dynamic`: sempre recebe o router
health-only e só recebe o router `/api/v1` renderizado em tmpfs quando o
override funcional e seu secret file-backed forem explicitamente aplicados.
O `invitation-worker` permanece implementado no produto, mas não faz parte da
stack base de produção.

Os defaults provisórios limitam API e migration a 0,75 CPU/1 GB e PostgreSQL a
1 CPU/2 GB, com `pids_limit`, heap Node conservador e rotação de logs `10m`/`5`.
Esses valores precisam ser confirmados contra o inventário real da VPS na
`0.8-MVP-05`.

## Segurança mínima

- isolamento entre Organizations em todas as superfícies tenant-scoped;
- autenticação, autorização e papéis `owner`, `admin` e `member`;
- secrets fora do Git, frontend, imagem, documentação e logs;
- HTTPS e bloqueio de acesso direto à API e ao PostgreSQL;
- PostgreSQL persistente em rede privada;
- role runtime distinta da role proprietária de migrations;
- migrations versionadas e controladas;
- backup, restore testado, logs sanitizados, health e rollback;
- teste do fluxo principal e do isolamento cross-tenant;
- vulnerabilidade Critical aplicável bloqueia a abertura até correção ou
  decisão humana explícita.

## Health

O runtime possui os estados `starting`, `ready`, `draining` e `stopped`.
Liveness não consulta PostgreSQL; readiness exige estado `ready` e `SELECT 1`
concluído dentro do deadline de resposta de 1,5 segundo. O shutdown começa o
draining, possui deadline de 12 segundos e termina normalmente após os hooks.

| Endpoint                   | Função                                      |
| -------------------------- | ------------------------------------------- |
| `GET /health`              | readiness pública para a infraestrutura     |
| `GET /api/v1/health`       | alias de compatibilidade da readiness       |
| `GET /api/v1/health/live`  | liveness independente do PostgreSQL         |
| `GET /api/v1/health/ready` | readiness explícita do runtime e PostgreSQL |

As respostas são apenas `{"status":"ok"}` ou
`{"status":"unavailable"}`, com `Cache-Control: no-store`, sem versão,
topologia, credencial ou causa interna.

## CI, publicação de imagem e deployment

O CI automático em `.github/workflows/ci.yml` possui somente os jobs
`validate` e `build-and-scan`, ambos com `contents: read`. Pull Requests,
`push` na `main` e dispatch diagnóstico executam a validação completa e, depois
de seu sucesso, constroem uma imagem local `linux/amd64`, validam o runtime e
executam Trivy v0.70.0 com bloqueio de vulnerabilidade Critical. A imagem é
carregada somente no runner (`load: true`, `push: false`). O CI não recebe
`packages: write`, não autentica no GHCR, não publica manifest/tag e não chama
nenhum caminho de release ou deployment.

A publicação automática no `push` da `main` foi removida porque um merge não é
aprovação humana específica para release. O antigo grafo `image-impact` →
`publish-image` não existe mais no workflow automático. O detector versionado
continua como utilitário histórico testado, mas não concede capacidade de
registry nem participa do grafo atual.

### Publicação manual fail-closed

`.github/workflows/release-image.yml` aceita somente `workflow_dispatch` e
termina em `IMAGE_PUBLISHED_AND_DIGEST_VERIFIED`. Para solicitar uma publicação:

1. aprove separadamente o SHA exato da `main` que fornece o workflow
   (`workflowRef`) e o commit da aplicação que será publicado
   (`imageSourceSha`);
2. execute `scripts/dispatch-release-image.cjs` com os dois SHAs explícitos; o
   helper comprova a `main` remota, faz no máximo um dispatch e valida o run;
3. mantenha `ref: main` e copie o `imageSourceSha`, em 40 caracteres
   hexadecimais minúsculos, exclusivamente para o input `full_sha`;
4. marque `confirm_release=true`;
5. aguarde a aprovação humana do Environment protegido;
6. confirme no resumo o repositório, SHA, tag, digest, ator, run, horário e o
   resultado do scan.

Na API do GitHub, `ref: main` — ou o `--ref main` semanticamente equivalente
da CLI — escolhe a versão do workflow. Um SHA bruto nunca deve ocupar esse
campo. O SHA da aplicação ocupa somente `inputs.full_sha`. Antes da operação
real, use o modo sem mutação para verificar identidades e payload:

```bash
node scripts/dispatch-release-image.cjs \
  --workflow-ref <approved-full-main-sha> \
  --image-source-sha <approved-full-application-sha> \
  --dry-run
```

Remover `--dry-run` é uma operação mutável separada e só é permitido por uma
janela de release explicitamente autorizada. O helper identifica o workflow
inequivocamente por `.github/workflows/release-image.yml`, registra o conjunto
anterior de runs e o instante da operação, consulta a referência remota
autoritativa de `main` imediatamente antes do dispatch e exige
`remoteMainSha === workflowRef`. Divergência termina como
`MAIN_MOVED_BEFORE_DISPATCH`; o helper não seleciona automaticamente a nova
revisão.

Uma resposta HTTP 204 não contém `runId`. Nesse caso, o helper não repete o
dispatch: ele faz polling limitado somente no workflow correto, evento
`workflow_dispatch` e runs novos a partir do início registrado. Exige exatamente
um candidato e então comprova `head_sha === workflowRef` e
`head_branch === main`. SHA ou branch divergente bloqueia aprovação humana,
solicita o cancelamento fail-closed do run e sinaliza que o guardian operacional
deve restaurar `MANUAL_IMAGE_RELEASE_ENABLED=false`. Zero ou múltiplos
candidatos permanecem inconclusivos e exigem investigação e nova decisão
humana.

HTTP 422 e qualquer resposta de dispatch ambígua falham sem fallback e sem
retry. Os estados estruturados usam exit `0` para `DRY_RUN_READY` ou
`DISPATCH_CONFIRMED`; `20` para `MAIN_MOVED_BEFORE_DISPATCH`; `21` para HTTP
422; `22` para resposta ambígua; `23` para zero run; `24` para múltiplos runs;
`25` para `head_sha` divergente; `26` para branch divergente; e `27` quando uma
leitura autoritativa não pode ser comprovada. Qualquer falha exige nova decisão
humana; nunca transforme um estado inconclusivo em um segundo dispatch.

O workflow falha antes de login se a confirmação não for exata, se o SHA não
tiver o formato completo, não resolver para um commit, não for ancestral da
`main`, divergir depois do checkout ou se a variável remota
`MANUAL_IMAGE_RELEASE_ENABLED` não for exatamente `true`. Dois checkouts sem
credenciais ficam em paths independentes: `release-control` é preso ao
`github.workflow_sha` que forneceu o próprio workflow, enquanto `image-source`
recebe a história de `main` e então seleciona em modo detached somente o SHA
autorizado. O contexto de build e o teste de runtime usam exclusivamente
`image-source`; a inspeção do tag usa exclusivamente o script versionado de
`release-control`. Assim, publicar um `imageSourceSha` anterior à introdução do
controle não remove a ferramenta da revisão do workflow. A imagem é validada e
escaneada antes de qualquer autenticação; não se confia em artifact produzido
por outro run.

As permissões globais são `contents: read`. Somente o job manual
`publish-image`, associado ao Environment `ghcr-production-release`, possui
`packages: write`. O login usa o `GITHUB_TOKEN` efêmero e ocorre depois de
Environment, enablement, identidade Git, build, runtime e scan aprovados.

O tag é exclusivamente `sha-<SHA completo>`; não há referência operacional
`latest` ou `main`. Runs do mesmo SHA são serializados sem cancelamento, e o
label OCI `created` deriva do timestamp do commit para manter a identidade de
build estável. Depois do login, o workflow consulta o tag sem mutação. Se ele
estiver definitivamente ausente, faz uma segunda consulta imediatamente antes
de um único push e aborta se o tag tiver surgido ou se o resultado for
ambíguo. A inspeção produz somente `TAG_AVAILABLE` para essa ausência
definitiva. Qualquer descriptor válido de presença produz
`TAG_ALREADY_EXISTS`, sem tentar provar equivalência com a imagem local. Assim,
um conteúdo igual ou uma colisão são igualmente bloqueantes e nunca
sobrescrevem nem reutilizam o tag nessa execução. Resposta vazia, inválida ou
ambígua e erros de
autenticação, autorização, rate limit ou servidor também terminam sem alterar o
registry.

“Definitivamente ausente” é uma classificação centralizada e idêntica nas duas
consultas. Ela reconhece exclusivamente a assinatura real do Buildx 0.36.1
preservada pelo artifact sanitizado da tentativa 4: `ERROR: <IMAGE_REF
exato>: not found` seguido de exatamente um byte LF (`0x0A`). Essa observação
teve exit `1`, stdout de zero bytes e foi corroborada pelo estado estável do
registry. `manifest unknown`, `name unknown`, `no such manifest`, `404 Not
Found` textual ou `not found` genérico não são aceitos isoladamente pelo
classificador Buildx.

A implementação executa exatamente uma chamada Buildx por lookup e recebe seu
status, stdout e stderr sem `trim()`, normalização ou conversão de finais de
linha antes da comparação. Ela exige status `1`, stdout de zero bytes e stderr
UTF-8 byte a byte igual a `ERROR: <IMAGE_REF exato>: not found\n`, sem qualquer
byte anterior ou posterior. A forma sem LF, CRLF, LF adicional, linha extra,
espaço residual, diferença de referência ou caixa, ANSI, NUL, U+0085, U+2028 e
U+2029 permanece ambígua. O recheck também captura stdout em arquivo. Nenhuma
consulta secundária de manifest ou imagem pode descartar um exit code ou canal
causal. Erros de credential helper, plugin, autenticação, permissão, transporte,
timeout, rate limit ou servidor, conteúdo em ambos os canais e respostas
compostas ou desconhecidas abortam antes do push.

Quando um lookup falha, o workflow retém por 14 dias somente um JSON
estruturado e sanitizado com horário UTC em milissegundos, comando lógico sem
credencial, exit code do lookup, classe da resposta, status HTTP quando
conhecido e os dois canais sanitizados. Authorization, WWW-Authenticate,
tokens, senhas, auth Docker e credenciais são removidos; os arquivos brutos do
runner não são publicados. Falhar ao produzir ou preservar esse diagnóstico
também falha fechado.

Somente `TAG_AVAILABLE` habilita o recheck e, se ele também confirmar ausência,
o push. Depois desse único push, o workflow seleciona exatamente um manifest
digest, reinspeciona a referência por digest e compara manifest e config
digests com a imagem local escaneada. Repetir manualmente um release idêntico
falha fechado como `TAG_ALREADY_EXISTS`; não republica nem move o tag. O
artifact `image-release-identity.json`, retido por 14 dias, é apenas evidência
transitória. A fonte durável de verdade para promoção e rollback é:

`ghcr.io/arthurportodev/genesis-platform-api@sha256:<digest>`

O `workflowRef` identifica a revisão da `main` que contém o controle de release;
o input `full_sha` é o `imageSourceSha` aprovado separadamente. Corrigir ou
executar o workflow a partir de uma `main` futura não muda silenciosamente a
fonte da imagem: `workflowRef` ocupa `release-control`, enquanto
`imageSourceSha` ocupa `image-source`. Na janela autorizada concluída pelo run
`33661648091`, o source selecionado foi
`ac2f8cd96ae02c1cad52366871bdde8ca651631d`; a publicação resultou no digest
imutável `sha256:c53b283571955fa4ad2a056270bbc4b03222028e56d5177208c1a788696149f7`
e não constitui deployment.

Preserve a imagem e esse digest até a desativação da fixture. Exclusão,
limpeza ou alteração de retenção do digest exige Gate posterior. Um deployment
futuro deve consumir a referência por digest, nunca depender apenas da tag.

### Controle remoto e habilitação de uma futura publicação

A inspeção read-only de 20/08/2026 confirmou que o Environment
`ghcr-production-release` existe e tem três proteções: required reviewer humano,
wait timer de um minuto e policy custom restrita à branch `main`. O Environment
tem zero secrets e uma única variável, `MANUAL_IMAGE_RELEASE_ENABLED=false`.
A prevenção de self-review está desabilitada e administradores podem fazer
bypass; esses limites não autorizam habilitação nem dispatch.

Antes de qualquer execução, um Gate remoto separado deve obter autorização
humana explícita, reconfirmar as proteções e a branch elegível, e somente então
alterar `MANUAL_IMAGE_RELEASE_ENABLED` para `true` durante a janela autorizada.
O dispatch manual permanece uma ação separada e também requer autorização.

Enquanto a variável estiver ausente ou diferente de `true`, o publicador
permanece fail-closed. Para revogar, altere-a para `false` ou remova-a; para uma
suspensão adicional, desabilite o workflow. Nenhum desses procedimentos exclui
o digest já publicado.

### Separação obrigatória do deployment

CI valida; release publica e verifica uma imagem; deployment promove um digest
para runtime. O workflow de release não acessa VPS, Vercel, Traefik ou banco,
não chama webhook, não altera container em execução e não executa migration ou
fixture. Deployment permanece uma tarefa distinta, com aprovação humana,
allowlist, rollback e evidência próprios. A ausência dessas ações no grafo YAML
é validada por regressões estruturais versionadas.
<!-- genesis-memory-history:start -->

### Snapshot histórico da publicação GHCR

No ciclo histórico da `0.8-MVP-04`, Arthur aprovou manter público o package
`ghcr.io/arthurportodev/genesis-platform-api`. A integridade não depende de
sigilo do artefato: ela é garantida por tag com SHA completo, referência por
digest, labels OCI, scans Critical e permissões mínimas. A versão histórica
original possui somente a tag
`sha-c02af719c72277f49348de33762ff12dc589434d`, manifest digest
`sha256:c839d9d89aa12648e147eebfc2d5b5a09c62080ff50881318e2984ea51ccdc69`
e config digest
`sha256:c4bccf7a8e37aa73d46d6717876841a3fe6e343797753786150f8f350c649d9f`.
O fechamento da correção publicou somente a tag
`sha-c6fbc0b865540abd9d13f93c7cc7542eb0936355`, manifest digest
`sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659`
e config digest
`sha256:696d37b59113ad6bc45247c1b9381b2238a322eb365f82ad6c2c9135456765d9`.
Esta correção de filtro não altera nem republica nenhuma dessas versões.
O marcador visual “Latest” do GitHub não é uma tag `latest`.

<!-- genesis-memory-history:end -->

O destino arquitetural aprovado para o MVP é GHCR privado. Esta correção
documental não muda workflow, package ou visibilidade; a transição exige tarefa
operacional própria. A visibilidade live é resolvida somente pela memória
canônica e não é inferida do histórico acima.

O runtime final usa `alpine:3.24`; `node:24-alpine3.24` fica restrito aos
estágios que executam npm e build. A imagem final recebe somente o executável
Node, `libstdc++`, dependências podadas, `dist` e `package.json`. npm, npx, Yarn,
Corepack, módulos globais e o pacote npm `tar` não entram no runtime. O contrato
estrutural e a inspeção da imagem real verificam esse limite antes do Trivy e de
qualquer lookup ou push. Em rerun, qualquer tag full-SHA existente é bloqueante.
Mesmo quando o conteúdo remoto é equivalente à imagem local já escaneada, a
inspeção produz `TAG_ALREADY_EXISTS` e encerra a execução fail-closed, sem
reutilizar ou sobrescrever tag ou digest e sem tratar o resultado como sucesso
idempotente. O operador deve investigar o estado existente; um novo dispatch
com essa tag não alcança o push.

Essa entrega não depende de cadeia customizada de evidências. Controles
avançados de supply chain são backlog pós-MVP.

## Deploy simples da API

O procedimento vigente para novos deploys da API é o
`SIMPLE_VPS_DEPLOYMENT` do [ADR-020](decisions/ADR-020-simple-vps-deployment.md),
implementado por `docker/production/deploy-api-simple.py`. A implementação desta
Task prepara e testa o operador, mas não instala arquivos nem autoriza uma
execução na VPS.

O diretório `/opt/genesis/deploy` é fixo, `root:root` e não gravável por
group/other. Ele contém somente a allowlist do operador e
`operational-integrity.json`; não há diretório por release. Para uma instalação
futura, o manifesto é criado a partir de um checkout Git limpo cujo `HEAD` seja
exatamente o `operationalSourceSha` aprovado no Gate A. O comando rejeita bytes
dirty ou um commit diferente:

```bash
python3 <approved-checkout>/docker/production/deploy-api-simple.py manifest \
  --source-root <approved-checkout> \
  --production-env /opt/genesis/config/production.env \
  --operational-source-sha <approved-40-hex-source-sha> \
  --output /opt/genesis/deploy/operational-integrity.json
```

`production.env` contém exatamente a configuração não secreta aprovada, é
`root:root 0600` e tem SHA-256 vinculado pelo manifesto. O pointer separado
`/opt/genesis/config/api-image.env` é `root:root 0600`, regular, sem hardlink e
tem exatamente uma linha:

```text
API_IMAGE=ghcr.io/arthurportodev/genesis-platform-api@sha256:<64-hex>
```

Compose é sempre chamado com `-p genesis`, `--project-directory
/opt/genesis/deploy`, os env files `production.env` e `api-image.env` nessa
ordem e os três Compose files absolutos. `api` e `migrate` exigem o mesmo
`API_IMAGE`, sem fallback. O operador sempre exige, lê e confronta
`api-image.env` com Docker. Ele limpa valores hostis herdados antes de cada
subprocesso; somente inventory/migration do candidate recebe override explícito.
Promoção e rollback revalidam o pointer e renderizam Compose sem `API_IMAGE` no
ambiente filho antes da recriação.

O comando `preflight` é a entrada read-only. Ele recebe separadamente
`--application-source-sha` e `--operational-source-sha` e valida host/plataforma,
integridade operacional, configuração, pointer/runtime, containers, volume,
secrets, capacidade, topologia e inventário de migrations. Se o lock único
`/run/lock/genesis-api-deploy.lock` ainda não existe, o probe o trata como livre
sem criá-lo; somente `execute`, depois do Gate B, pode criá-lo. Concorrência
encerra com `DEPLOYMENT_LOCK_HELD`.

`execute` não é autorizado por este documento. Uma tarefa operacional futura
deve aprovar a imagem/release, o application source SHA e o operational source
SHA e fornecer Gate B como a string exata
`<runId>:<applicationSourceSha>:<operationalSourceSha>:<candidate-image>:<level>`.
A evidência root-only de Gate A contém exatamente esses dois SHAs, a imagem, o
status aprovado e `approvedLevel2Pending`. O script aceita Level 1 somente sem
pending e Level 2 somente com cada `--expected-pending` igual a essa lista.
Level 2 reutiliza
`/opt/genesis/recovery/backup-runner.sh --mode checkpoint`, exige
status `passed`, executa migration one-shot e exige que o inventário final seja
exatamente o anterior concatenado ao pending aprovado. Level 3 termina em
`LEVEL_3_REQUIRES_SEPARATE_ARCHITECTURE`.

A promoção escreve o pointer atomicamente e executa somente `docker compose up
-d --no-deps --force-recreate api`. PostgreSQL e Traefik devem conservar seus
IDs. Health interno usa Docker; health externo consulta somente
`https://api.agenciagenesismkt.com.br/health`; o smoke funcional completo usa o
proxy same-origin em `https://app.agenciagenesismkt.com.br`. Observation ocorre
em T+0/T+30/T+120 no Level 1 e T+0/T+60/T+300 no Level 2. Todos os subprocessos
têm timeout fixo por categoria; 5xx é detectado somente pelo campo inteiro
`DownstreamStatus` de cada linha JSON válida do access log do Traefik.

Evidence progressiva fica em
`/var/lib/genesis/deploy/evidence/<runId>.json`, `root:root 0600`, sem tokens,
cookies, passwords, CSRF ou bodies. A primeira falha é imutável. Se já houve
promoção, rollback regrava o previous pointer e recria somente a API; nunca
reverte migration. Falha de rollback preserva a causa inicial e termina em
`ROLLBACK_FAILED / ESCALATION_REQUIRED`. Se a persistência da evidence falhar
depois da promoção, a causa permanece em memória e nenhuma nova escrita de
auditoria antecede ou interrompe o rollback; o estado terminal é persistido
somente por uma tentativa best-effort depois da restauração do runtime.

### Transição para o primeiro deploy simples

Esta Task é somente a fase de implementação no repositório. Uma entrega Git
posterior a Gate 2 também não altera o runtime. Na futura Task operacional, o
primeiro deploy simples deve, antes de qualquer promoção:

1. descobrir no Docker o digest factual atualmente executado;
2. provar que essa imagem anterior é imutável, local ou pullable, com RepoDigest
   e arquitetura `linux/amd64` corretos;
3. instalar somente os arquivos allowlisted do mecanismo novo em
   `/opt/genesis/deploy`;
4. inicializar `api-image.env` com o digest factual anterior e provar
   pointer == runtime;
5. confirmar API, PostgreSQL e Traefik healthy, executar o novo preflight e
   obter Gate B;
6. promover pela primeira vez somente depois de o rollback novo ter sido
   exercitado em rehearsal ou ambiente descartável.

Se a imagem anterior não puder ser provada, o resultado é
`STOP BEFORE MUTATION`. Se a primeira promoção falhar, o único rollback
suportado é `previous digest -> pointer -> API-only recreate -> health`; ele não
invoca o harness anterior. A produção permanece intocada até essa Task futura.

## Deploy manual histórico — superseded para novos deploys

Esta seção é mantida exclusivamente para história e auditoria. O release-tree é
**legacy / unsupported for new deploys** depois da introdução do contrato
Compose/pointer do ADR-020, pode não renderizar esse Compose atual e não é
fallback para o deploy simples. Não há adaptador entre os dois modelos; cleanup
é uma Task futura separada.

O operador histórico e versionado para a promoção por release-tree é
`docker/production/deploy-api-release.py`. Ele usa somente Python 3 e a
biblioteca padrão e expõe exatamente `prepare`, `preflight` e `execute`. Sua
presença, mode e hash integram os bundles `committed-release` current/rollback;
um bundle `candidate` continua não operacional.

O fluxo é:

1. selecionar commit aprovado e CI essencial verde;
2. publicar ou selecionar a imagem no GHCR por tag do commit e digest;
3. formar um plano JSON não secreto e obter aprovação humana de seus bytes,
   SHA-256 e `authorizationId`;
4. executar `prepare` localmente para validar os dois bundles e seus
   fingerprints, formar archives determinísticos, calcular hashes e, quando
   explicitamente pedido, transferir somente os cinco artefatos allowlisted
   por SSH com `BatchMode`, host key estrita e alias aprovado;
5. executar `prepare --from-transport` no host para extrair os archives em
   `<remoteWorkspace>/materialized/{current,rollback}` com a validação segura
   do operador, rejeitando traversal, symlink, tipo especial e path extra;
6. executar `preflight` no host para provar hostname `srv1870064`,
   `linux/amd64`, release/digest ativos, rollback, containers, labels, volume,
   migration baseline e pending set exatos, secret metadata e capacidade;
7. obter autorização humana específica para a mutação e executar `execute`;
8. observar health, smoke e runtime até o estado
   `CANDIDATE_OBSERVED / READY_FOR_KEEP`, ou executar application rollback.

O deploy permanece manual. A execução 09E já ocorreu conforme a seção de
execução histórica acima; esta sequência não autoriza repetição nem transforma
o helper histórico em procedimento atual. Todo novo deploy usa o fluxo simples,
com imagem anterior/candidate imutáveis, smoke, evidência e autorização humana
próprios.

No host, `preflight` e `execute` aceitam somente os dois paths materializados
acima e `<remoteWorkspace>/evidence.jsonl`; um path arbitrário é recusado.

### Plano e fronteira de mutação

O plano `genesis-api-deployment-plan.v1` é fechado: campos extras ou defaults
implícitos são recusados. Ele vincula run ID de 16 hex, authorization ID,
source commit, alias/fingerprint SSH, paths fixos, digests e fingerprints
current/rollback, baseline Compose, ordered migrations, referências de secrets,
smoke e a janela de observation. Secret files são apenas referenciados; seus
valores, hashes, cookies, tokens e bodies nunca entram no plano nem no JSONL de
evidência.

`preflight` é read-only e termina em `PRE_MUTATION_READY` ou
`STOP BEFORE MUTATION`. `execute` exige simultaneamente:

- `--authorize-production-mutation`;
- `GENESIS_PRODUCTION_MUTATION_AUTHORIZED=true`;
- `--authorization-id` igual ao plano;
- `--approved-plan-sha` igual ao SHA-256 dos bytes do plano.

O operador valida esses fatores antes do lock e novamente depois de adquirir
`/run/lock/genesis-api-deployment.lock` e repetir o preflight. Somente então
emite `MUTATION_AUTHORIZED`; antes desse evento, registry auth/pull, migration,
activation e recreate são impossíveis. O Docker config temporário de registry
fica root-only sob `/run`, recebe a senha por stdin e é removido mesmo em falha.

Após o pull por digest, o operador executa apenas o service Compose canônico
`migrate`, que chama TypeORM `migration:run` com a role dedicada. Tanto esse
comando quanto o recreate posterior da API usam explicitamente `--env-file
<release>/config/production.env.example`, antes do `--project-directory` e do
Compose file do mesmo release. Assim, a interpolação é vinculada à configuração
não secreta versionada do bundle. Antes de invocar Compose, o operador deriva
todos os nomes declarados nesse arquivo e os remove de uma cópia do ambiente
destinada somente ao processo filho. Isso impede que a precedência do shell
sobrescreva o contrato versionado, preserva variáveis não pertencentes ao
contrato e não modifica o ambiente global. Não há fallback para `.env` ambiente
nem injeção de outro path; os secrets permanecem file-backed. Se o arquivo
canônico estiver ausente ou possuir sintaxe inválida, o comando falha fechado.
O applied baseline, que nunca pode ser vazio, e o pending set ordenado devem ser
exatos antes. Quando há pending, o post-head é seu último item e o service
`migrate` é executado; quando pending é vazio, o post-head é o último item do
baseline, o comando é omitido e um novo snapshot ainda prova o mesmo conjunto
antes da activation. Falha ou estado ambíguo impede activation;
`migration:revert` não é executado.

Activation delega a troca atômica a `release-tree-manager.py activate`. Em
seguida, o único recreate permitido é `docker compose ... up -d --no-deps
--force-recreate api`; os IDs de PostgreSQL e Traefik são comparados antes e
depois. Health interno/público, liveness, readiness, TLS, CSRF/login/session,
tenant e Kanban são validados sem registrar payloads. O preflight deriva
`releaseRole` da árvore ativa cujo manifesto está vinculado ao fingerprint e à
imagem observados, aceitando somente `current` ou `rollback`; depois da
activation o candidate continua obrigado a `current`, e o terminal de rollback
continua obrigado a `rollback`. O contrato financeiro do
smoke aceita dados genéricos e valida BRL, totais minor em string, contagem sem
valor, agregados de estágio e `expectedValueMinor` string/null.

### Observation, rollback e KEEP

A execução real observa por 900 segundos nos checkpoints T+0, T+2, T+5,
T+10 e T+15. Health/readiness, restart count, 5xx, CPU, memória, disco,
PostgreSQL, Traefik e logs sanitizados são gates. Digest divergente, health ou
readiness falhos, restart inesperado, 5xx persistente, regressão de auth,
tenant/Kanban ou observabilidade acionam application rollback atômico para o
bundle/digest anterior, seguido apenas do recreate da API e smoke de
compatibilidade que consulta somente `GET /health`. O smoke completo do
candidate e o smoke de health da observation mantêm, sem redução, os quatro
endpoints `/health`, `/api/v1/health`, `/api/v1/health/live` e
`/api/v1/health/ready`; somente o modo de rollback é compatível com releases
anteriores que não expõem os três endpoints prefixados.

O rollback mantém o schema já expandido; nunca há database revert automático,
nem segunda tentativa de deployment. Falha no rollback preserva evidência e
termina em escalation. Sucesso da observation declara somente
`CANDIDATE_OBSERVED / READY_FOR_KEEP`: o candidate permanece ativo e o rollback
permanece preservado. `KEEP` e cleanup do rollback exigem autorizações humanas
separadas e nunca são emitidos por este operador.

## Migrations

Migrations versionadas são a única fonte do schema; `synchronize` e
`migrationsRun` permanecem desabilitados. A role de migration é separada e sua
credencial não fica disponível ao runtime. O job de migration é único e
bloqueante. Rollback da aplicação não reverte schema automaticamente; uma
migration incompatível exige plano específico antes do deploy.

## Onboarding privado de OWNER

A criação inicial autorizada de uma organização e de seu OWNER usa o CLI
`npm run operator:owner`, nunca o seed legado ou uma rota pública. Pré-condições,
autorização literal, TTY mascarado, transação `SERIALIZABLE`, verificação por
`status` e smoke humano estão no
[runbook de onboarding](PRODUCTION_OWNER_ONBOARDING.md).

Bootstrap/admin é superuser somente durante inicialização e recuperação
excepcional. A migration owner possui o database/schema, mas é explicitamente
`NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`. Runtime possui os
mesmos atributos negativos, não é owner e recebe somente ACLs funcionais das
migrations. Os três nomes são seguros, distintos e sem memberships entre si.

Na imagem de produção, o job executa diretamente
`node node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run`.
Ele não recompila a aplicação, não depende do Nest CLI e não executa seed.

## Bundle de produção

`scripts/build-production-bundle.cjs` gera um diretório novo com allowlist
fechada de Compose, configuração não secreta, wrappers, Traefik, recovery,
operador de deployment, gerenciador da árvore e `release-manifest.json`.
Existem exatamente dois modos:

- `candidate` é não operacional, copia a worktree somente para validação local
  e registra `baseSha`, `candidateId` e `contentFingerprint`. Ele não declara
  `sourceCommit` e nunca pode ser usado em VPS;
- `committed-release` é operacional, exige um commit real, lê cada artefato do
  snapshot Git declarado e falha se path, blob, mode ou bytes correspondentes
  da worktree divergirem. Somente esse modo pode ser transferido em uma tarefa
  futura.

Todo bundle também declara `releaseRole`. `candidate` aceita apenas `current`.
Após o merge, `committed-release --release-role current` produz o release a
promover; `--release-role rollback` produz um segundo release operacional
ligado à aplicação, manifest digest e config digest `previous-approved`. Nesse
segundo papel, o builder deriva somente `compose.production.yml` do mesmo
snapshot contendo o contrato: exige exatamente duas referências da imagem
corrente, substitui ambas pela imagem de rollback e registra no manifesto o
hash fonte, `from`, `to` e a contagem. Não existe override de imagem livre.
Antes de qualquer ativação,
`release-tree-manager.py verify-pair` revalida os dois bundles e prova que o
Compose rollback é exatamente o Compose current com essas duas substituições,
que ambos declaram o mesmo `sourceCommit` — distinto das application revisions
das imagens — e que todos os demais bytes e metadados são idênticos.

O manifesto v2 também registra hashes, type/owner/group/mode de arquivos,
metadata dos onze diretórios, digests, `linux/amd64`, versão do contrato e
timestamp reproduzível derivado do commit de referência ou de
`SOURCE_DATE_EPOCH`; ele não representa o relógio real do deploy. Todos os
diretórios ativos são `root:root 0755`; staging é criado `root:root 0700` e só
recebe `0755` depois de completo, sincronizado e validado.
`scripts/validate-production-bundle.cjs` rejeita arquivo extra, artefato
irregular, binding divergente, candidate usado como release, proveniência Git
incompleta, metadata de árvore divergente, tag, path `.env` e conteúdo
secret-like. A validação operacional deve usar
`--require-mode committed-release`.

Os arquivos do bundle usam mode Git/manifest `0644`. Os wrappers de API e
migration não dependem de execute bit porque o Compose os chama
explicitamente por `/bin/sh`. O init PostgreSQL também não depende de execute
bit: o
[`docker-entrypoint.sh` oficial congelado](https://github.com/docker-library/postgres/blob/4f9ced003ba58a854656ba150d146243d27ae3ac/docker-entrypoint.sh#L158-L188)
faz `source` de todo `.sh` não executável encontrado em
`/docker-entrypoint-initdb.d`. Mode `0755` ou qualquer outro mode diverge do
contrato e bloqueia `committed-release`. O gerenciador da árvore é chamado
explicitamente por `python3`, portanto também permanece `0644`.

### Instalação íntegra e troca atômica

`docker/production/release-tree-manager.py` é fail-closed e só opera como root.
Ele valida o fingerprint e a imagem esperados, recusa bundle que não seja
`committed-release`, e rejeita ausência, entrada extra, tipo especial, hash,
owner/group/mode, escrita por group/other, ACL, symlink, hardlink, mount
boundary e path de secret/runtime. Hashes são calculados somente nos arquivos
regulares da allowlist do manifesto.

Uma operação futura, sob Gate próprio, deve:

1. adquirir `/run/lock/genesis-release-tree.lock` exclusivamente;
2. regenerar e validar separadamente os papéis `current` e `rollback` a partir
   do containing commit aprovado, com fingerprints distintos e derivação
   fechada da imagem `previous-approved`;
3. construir siblings no mesmo filesystem sem usar a árvore ativa como fonte;
4. aplicar e validar toda a metadata antes da ativação;
5. provar `renameat2(RENAME_EXCHANGE)` trocando os siblings duas vezes;
6. trocar staging e `/opt/genesis/release` atomicamente e sincronizar o parent;
7. restringir a árvore antiga a `root:root 0700`, marcá-la `UNTRUSTED` e
   preservá-la sem torná-la rollback;
8. em falha pós-troca, ativar atomicamente o rollback já verificado.

`ATOMIC_PRIMITIVE_UNAVAILABLE` encerra a ação. Dois `mv` sequenciais, cópia da
árvore ativa e restauração da árvore antiga `0777` são proibidos. Secrets,
recovery state, `/opt/genesis/traefik-state`, Docker/volumes e PostgreSQL ficam
fora da travessia e da troca; o procedimento não reinicia serviços nem executa
backup, migration ou Compose.

### Reparo one-time da baseline 09E

O deployment histórico 09E deixou o runtime da API em
`0a56a8aee7c64bda59a1981888418e1ad03950c0` e na imagem imutável
`sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb`,
com config digest
`sha256:1cd0615209cd0ac5b00b9b89754d525a1af9eead3d727f3397a98bfe33d08b24`,
mas preservou em `/opt/genesis/release` o manifesto anterior `9402d067... /
a4dafefa...` e o overlay `deployment-state`. Editar somente o manifesto não é
um reparo válido: a árvore inteira precisa voltar à allowlist canônica.

O profile fechado `baseline-repair-09e` existe exclusivamente para construir,
de um futuro containing commit real, um `committed-release` de papel `current`
com a aplicação/imagem/config já ativas. Ele registra
`9402d067897ab727fb369d7e696a11ba3b9cf68f`,
`sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a`
e `sha256:ba67e2ab1bb92d3486e9f37c602fd4c374330d54b2697b5b1bca79d925a96bd9`
como `previous-approved`, não aceita override de aplicação, imagem ou config e
não participa da promoção PIPE-V2 `ac2f8cd... / c53b283...`.

Sob tarefa e Gate humano próprios, `release-tree-manager.py repair-baseline`
exige o fingerprint histórico aprovado
`sha256:752084dda34619155617fb40b42c518ff3a1129ec30e7d22dbd0994d965d64b8`,
revalida sob o lock da release e reconhece `deployment-state` somente pelo
inventário 09E fechado coletado read-only: cinco diretórios e dezoito arquivos
regulares, sem entrada adicional, todos `root:root`, no mesmo device, com modes
e SHA-256 exatos. Os sete pares `*.sanitized.log`/`.sha256` são validados tanto
pelo hash de cada arquivo quanto pelo conteúdo ASCII do companion, que deve ter
uma única linha LF no formato `<digest><dois espaços><basename>` e declarar o
hash real do log correspondente. Conteúdo bruto dos logs não é emitido.

O reparo constrói uma árvore root-only no mesmo filesystem e usa somente
`renameat2(RENAME_EXCHANGE)`. A árvore antiga, com seus bytes e inode
preservados, passa para
`.genesis-release-baseline-repair-backup-<runId>`. Falha após a troca provoca o
exchange inverso imediato e a prova da identidade anterior; não existe
fallback não atômico.

`restore-baseline-repair` aceita somente o backup derivado do mesmo `runId`, o
fingerprint exato da árvore reparada e o `backupIdentity` emitido pelo reparo.
Ele também usa exchange atômico e restaura a árvore antiga sem chamar Docker,
Compose, cliente de banco ou migration. Nenhum desses comandos constitui
autorização de produção, e este texto não declara que o reparo foi executado.

Lacuna durável conhecida, fora deste reparo: depois de um rollback normal, a
árvore ativa possui `releaseRole=rollback`, enquanto um preflight posterior do
operador precisa preservar essa identidade. O operador agora deriva o papel do
manifesto ativo vinculado ao fingerprint e aceita a baseline somente como
`current` ou `rollback`, sem enfraquecer os papéis fixos do candidate e do
terminal de rollback. Ele também reconhece um sibling
`.genesis-release-staging-<runId>` preservado pela troca atômica somente quando
nome, diretório root-owned não symlink, marker fechado `UNTRUSTED` com reason
`previous-active-tree` e manifesto são válidos. Para o run corrente, fingerprint
e imagem do manifesto precisam ser exatamente os da baseline aprovada;
stagings históricos exigem allowlist explícita e suffix de 16 hex. Qualquer
marker, run, manifesto ou sibling arbitrário divergente continua bloqueando.

Nenhum bundle pré-merge pode ser transferido à VPS. A operação 05B usou somente um
`committed-release` reconstruído a partir do commit aprovado
`38baf1e8898194b618cfee787a3bea753677eb93`; qualquer nova transferência exige
tarefa e autorização operacional próprias.

Depois do merge, essa prova foi executada contra o squash
`5268706d22cb69df7d065928c16b4425a03b41cf`: o bundle
`committed-release` declarou esse `sourceCommit`, conteve exatamente os seis
arquivos permitidos, todos em mode `0644`, e passou no builder e no validator
operacional. O bundle pós-merge foi somente validado como artefato local e não
foi transferido. Os bundles pré-merge em modo `candidate` continuam evidência
não operacional e nunca foram promovidos ou enviados à VPS.

<!-- genesis-memory-history:start -->

## Snapshot histórico — execução e fechamento da 0.8-MVP-05B

A `0.8-MVP-05B` concluiu a baseline privada em 9 de agosto de 2026, sob tarefas
operacionais autorizadas e checkpoints independentes. Foram comprovados:

1. identidade, inventário, capacidade, hardening, anti-lockout e persistência
   do host;
2. commit, release `committed-release`, seis arquivos, hashes, modes, digests e
   plataforma `linux/amd64` exatos; o manifesto
   `0c2e6d0ad2943e802c955eb21cf7fa1283adca4267666cfb4902a20d0111f8e0`
   declara `0.8-MVP-05A.v2` e `operational=true`, `current` aponta atomicamente
   ao release aprovado e o release anterior permanece preservado;
3. Docker/Compose, layout root-only, grupo GID 70 e seis secrets file-backed
   com metadata restrita, sem exposição de valores; cinco são valores simples e
   um é um keyring versionado, todos regulares
   `root:genesis-container-secrets` `0440`;
4. volume externo original `genesis-postgres-data`, PostgreSQL 17 e três roles
   distintas com ownership e ACLs mínimos, usando a imagem
   `postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`,
   sem porta host;
5. bootstrap executado exatamente uma vez, dez migrations controladas na ordem
   esperada e uma segunda execução com exit `0` e zero migrations aplicadas;
6. API hardened e healthy, readiness `4/4`, mounts seletivos, metadata bloqueada
   e zero porta Docker publicada, usando
   `ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659`
   em `linux/amd64`;
7. leak scan zero, listeners externos limitados a TCP/22 e firewall externo
   TCP/22-only;
8. recuperação automática e persistência do estado após um único reboot
   autorizado, sem start manual, sob o novo boot ID
   `1203958f-2ae3-448c-83c1-349b0bb952d8`;
9. verificação final read-only com cobertura `11/11`, `findings=[]`,
   `limitations=[]` e recomendação `approve`.

O F-001 da captura foi limitado à validação fictícia, sem secret real
processado; a correção do driver PTY, a suíte fictícia `17/17`, a captura humana
sem eco e a reverificação resolveram o finding. O F-002 foi causado pelo init
sourced manter temporariamente as credenciais lógicas de migration/runtime no
processo PostgreSQL. O banco foi contido graciosamente sem perda; nenhum valor
ou hash foi impresso, os demais scans ficaram em zero, a correção foi incorporada
pelo PR #37 e o processo final não contém as duas variáveis.

A custódia dos seis secrets usa Bitwarden Free. O export JSON protegido por
senha fica fora da VPS em armazenamento offline cifrado, com a senha guardada
separadamente e recovery code fora da Bitwarden; nenhum CSV ou JSON aberto foi
produzido.

O snapshot pré-05B foi criado em 2026-08-09 às 09:10 BRT, permaneceu preservado
até o PASS técnico final e não foi restaurado nem excluído manualmente. Por
decisão do Product Owner, ele continua preservado até a expiração automática
indicada pela Hostinger em 2026-08-10. Esta documentação não afirma que a
expiração já ocorreu nem autoriza qualquer ação sobre o snapshot ou a VPS.

A conclusão da 05B não satisfaz os gates de abertura. Backup/restore,
observabilidade, rollback de abertura, Traefik/HTTPS, proxy same-origin, smoke
cross-tenant e autorização específica para dados reais continuam pendentes.
A VPS não está declarada pronta para produção, e este closeout não autoriza
nenhuma etapa futura de exposição ou deploy público.

<!-- genesis-memory-history:end -->

## Backup e restore

Backup de PostgreSQL é obrigatório antes de dados reais e deve ser protegido
contra perda junto com a VPS. O destino externo aprovado é Google Drive. RPO,
RTO e retenção são parâmetros temporais resolvidos na memória canônica. Secrets
de backup não entram no repositório nem em logs.

Um restore sintético deve ser testado em banco isolado antes da abertura. A
prova mínima inclui obter o backup, verificar integridade, restaurar, confirmar
migrations, executar health e consultas de smoke. Backup sem restore testado
não satisfaz a baseline.

## Rollback

O rollback manual seleciona o digest anterior aprovado, preserva rede e
persistência, reinicia uma réplica e repete health e smoke. Configurações do
Traefik e do frontend devem manter uma versão anterior recuperável. Perda ou
corrupção de dados aciona o procedimento de restore; não autoriza improvisação
no banco ativo.

## Logs e monitoramento

Logs são estruturados e sanitizados: não contêm secrets, tokens, cookies,
senhas, hashes ou PII desnecessária. O monitoramento inicial é básico e cobre
ao menos uptime externo, health, reinícios, CPU, memória, disco, PostgreSQL,
TLS e execução de backups. O monitoramento externo aprovado é UptimeRobot sobre
`/health`; política de alertas, destinatários e escalonamento são resolvidos na
memória canônica.

## Frontend e proxy

O frontend oficial aprovado é `app.agenciagenesismkt.com.br` na Vercel e usa
proxy server-side same-origin para `/api/v1`, com a API oficial em
`api.agenciagenesismkt.com.br`. O proxy preserva cookies, status, body e headers
contratuais, aplica `no-store` nas respostas sensíveis e impede que o fallback
da SPA responda por rotas da API. Preview não usa a origem de produção. Cookies
continuam host-only conforme o
[ADR-010](decisions/ADR-010-web-session-contract.md). Isso define arquitetura,
não comprova configuração live.

## Smoke tests

Antes de manter um deploy, validar:

- liveness e readiness interna e pública;
- login, refresh, logout e bootstrap;
- criação manual de Lead, Inbox, detalhe, Pipeline, Follow-up e métricas;
- autorização dos papéis `owner`, `admin` e `member`;
- negação uniforme de acesso cross-tenant;
- persistência após restart controlado;
- logs sem detalhes sensíveis;
- caminho de rollback disponível.

Dados sintéticos precedem qualquer dado real.

## Critérios de bloqueio

A abertura é bloqueada por:

- porta da API ou do PostgreSQL exposta diretamente;
- ausência de HTTPS, secrets protegidos ou isolamento tenant;
- migration não controlada ou role runtime privilegiada;
- backup ausente ou restore não testado;
- health, smoke, fluxo principal ou teste cross-tenant falho;
- logs com segredo ou PII indevida;
- rollback indisponível;
- vulnerabilidade Critical aplicável sem correção ou decisão humana;
- domínio, credencial, capacidade ou ferramenta ainda pendente quando necessária
  para a etapa executada.

## Definição de pronto

A primeira produção está pronta para usuários controlados quando a topologia
estiver publicada com HTTPS, proxy same-origin, API e banco privados; a imagem
estiver identificada por commit e digest; migrations, persistência, backup,
restore, logs, monitoramento básico, health, smoke, isolamento cross-tenant e
rollback estiverem comprovados; e houver aprovação humana de abertura.

Publicação técnica isolada não autoriza dados reais.

## Backlog pós-MVP

Não são gates automáticos do primeiro MVP: binder multidomínio customizado,
reconciliação formal de identidades OCI, atomic output-set avançado, packages
reconstruíveis de alta garantia, verificador independente em toda alteração,
provas equivalentes Windows/Linux em todo delta, banco Grype formalmente
selado, SBOM obrigatório, attestations avançadas, auditoria criptográfica
completa, pipeline customizado de supply chain e deploy totalmente automatizado.

Esses controles podem ser promovidos quando adoção, dados, compliance ou risco
justificarem.

## Operador remoto futuro

O operador remoto continua conceitual e ainda não está implementado. Ele não
integra a stack mínima, não é requisito para o primeiro MVP e não substitui o
deploy manual documentado. Qualquer implementação ou execução futura exige
tarefa própria e autorização humana separada.

Se implementado futuramente, deverá manter um writer por recurso compartilhado
e produzir `evidence-manifest.v1` com o estado e o resultado da operação.
Esses controles permanecem no backlog de maturidade e não são gates da
primeira publicação do MVP.

## Autoridade dos parâmetros operacionais

Hostinger KVM 2, Vercel, `app.agenciagenesismkt.com.br`,
`api.agenciagenesismkt.com.br`, NestJS em container, PostgreSQL privado,
Traefik, GHCR privado, deploy inicial manual aprovado, Google Drive,
UptimeRobot sobre `/health` e produção sem staging são destinos arquiteturais
aprovados no ADR-013. Sua implementação e seu estado live não são inferidos
deste runbook.

RPO, RTO, retenção, política de alertas, destinatários, escalonamento e
autorização de usuários/dados reais são resolvidos exclusivamente em
`docs/memory/project-state.v1.json`; não mantenha uma segunda lista temporal
neste documento.

<!-- genesis-memory-history:start -->

## Snapshot histórico — candidato 0.8-MVP-06A e plano de exposição

Este contrato está preparado na branch candidata e aguarda Gate 2; não está
incorporado à `main` e não autoriza execução na VPS. A imagem oficial selecionada
é Traefik `v3.7.9`, `linux/amd64`, fixada em
`traefik@sha256:652929a140a32d7cafafb13c6cdfab5376cfeff800f51397b87b524501ed02a8`.
Fonte: `https://github.com/traefik/traefik`; imagem criada em
`2026-07-24T19:31:24.4220685Z`; seleção revisada em `2026-08-10`.

### Arquivos e modos

- `compose.production.yml`: Traefik sem `ports`, API e banco privados.
- `compose.traefik-internal.yml`: somente loopback 18080/18443.
- `compose.traefik-public-http.yml`: IPv4/80 público e 18443 em loopback;
  staging é o default, e a produção pode ser selecionada mantendo este binding.
- `compose.traefik-public-full.yml`: IPv4/80 e IPv4/443 públicos, somente após
  certificado de produção válido.
- `docker/traefik/traefik-internal.yml`: ACME desabilitado.
- `docker/traefik/traefik-acme-staging.yml` e
  `traefik-acme-production.yml`: CAs e storages separados.
- `docker/traefik/dynamic/api-health-only.yml`: somente `GET /health` no host
  da API; demais rotas e métodos retornam fail-closed no edge.

`ACME_EMAIL` é parâmetro obrigatório e não secreto. O valor
`acme-contact-required@genesis.invalid` serve apenas para validação local e deve
ser substituído pelo email aprovado antes de qualquer ACME. O wrapper valida o
formato, não imprime o valor e materializa a configuração somente no tmpfs
read-only do container. `/opt/genesis/traefik-state` deve existir fora do Git
com `acme-staging.json` e `acme.json` regulares, persistentes e `0600`; seu
conteúdo nunca entra em logs, backup de evidência ou comandos de inspeção.

### Sequência operacional futura — não executada

1. Usar apenas bundle `committed-release` incorporado à `main` e autorização
   live específica.
2. Instalar o base sem portas e criar os dois arquivos ACME com `0600`.
3. Iniciar `internal`, provar bindings loopback e matriz health-only.
4. Configurar `TRUST_PROXY_HOPS=1`, recriar somente a API e provar IP real,
   rate limit, auditoria e spoof adversarial.
5. Após autoridade DNS e A sem AAAA, autorizar separadamente IPv4/80 no modo
   `public-http`; executar ACME staging.
6. Manter `public-http`, selecionar produção, obter e validar o certificado por
   SNI em `127.0.0.1:18443` sem imprimir o estado ACME.
7. Somente então autorizar `public-full` e executar smoke externo independente.

Os modos públicos nunca são iniciados durante validação local. UFW permanece
defesa do host, não gate de publicação Docker. Rollback começa por parar o
Traefik ou recriá-lo em `internal`; se ele sair da topologia, restaurar
`TRUST_PROXY_HOPS=0` e recriar somente a API. Nunca usar `down -v`, apagar
estado ACME, tocar no volume PostgreSQL ou inferir privacidade pela ausência de
regra UFW.

Naquele snapshot, produção, DNS, firewall, GHCR, Vercel, certificados, usuários
e dados reais permaneciam inalterados. HTTPS ainda não havia sido observado e
o gate `RG-TLS` seguia pendente; tarefas posteriores supersederam esse estado.

<!-- genesis-memory-history:end -->

## Recovery incorporado — estado operacional

O contrato `0.8-MVP-07A.v2` adiciona tooling determinístico para dump lógico
PostgreSQL 17, cifragem age, transporte rclone, round trip remoto, retenção
trash-only e restore sintético em Docker isolado. O RPO é 24 horas, a
frequência 12 horas, os limiares 18/24 horas, o RTO lógico sintético quatro
horas e as retenções regular/checkpoint 30/90 dias com duas cópias verificadas.

A 07A não executou operação live. Na 07B, a Window R3 comprovou OAuth
`drive.file`, checkpoint cifrado e round trip, mas sofreu rollback trash-only
quando o restore revelou uma incompatibilidade ACL. A correção foi incorporada
e a Window R4 instalou atomicamente o committed release corrigido, preservando
o anterior para rollback e sem reiniciar API, PostgreSQL ou Traefik.

A R4 validou a credencial por leitura sem novo OAuth, produziu checkpoint
cifrado, comprovou download e SHA-256, restaurou em PostgreSQL 17 isolado e
validou ownership, RLS, ACLs positivas e as quatro negações intencionais. O
timer está habilitado e ativo; seu primeiro disparo real produziu a segunda
cópia verificada. Há um checkpoint R4 e um regular R4, ambos com ciphertext e
marcador imutáveis. O volume ativo permaneceu inacessado, o restore publicou
zero portas e todos os recursos e secrets sintéticos foram removidos.

O procedimento vigente segue [RECOVERY_RUNBOOK.md](RECOVERY_RUNBOOK.md). A role
`genesis_backup` é tratada como mutação explícita e limitada:
`genesis_bootstrap` pode criar somente a role ausente com `LOGIN`, `BYPASSRLS`,
`CONNECTION LIMIT 1` e membership exclusiva em `pg_read_all_data`; role
conforme é no-op e divergência interrompe sem reconciliação. Senha entra por
stdin e só o pgpass root-only é materializado. Rollback exige procedência exata
da própria window. Antes do rclone, evidência não secreta deve provar OAuth
externo `In production`, conta `admreserva433@gmail.com` e scope exato
`drive.file`; `Testing` e status não comprovável param a execução.
