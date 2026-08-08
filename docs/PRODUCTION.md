# Produção do MVP

Este documento é a autoridade operacional da primeira produção da Genesis
Platform. A decisão arquitetural está no
[ADR-013](decisions/ADR-013-mvp-production-baseline.md). O objetivo é publicar o
produto existente para testes reais com segurança proporcional ao MVP, sem
antecipar uma infraestrutura definitiva.

O contrato versionado de PostgreSQL, secrets e bundle está no
[ADR-014](decisions/ADR-014-versioned-production-contract.md). Ele é uma
candidata local da `0.8-MVP-05A`; ainda não foi entregue nem implantado.

## Objetivo

Operar uma instância pequena, compreensível e recuperável do frontend, da API e
do PostgreSQL. A abertura para usuários exige os controles mínimos deste
documento; requisitos avançados permanecem no backlog pós-MVP.

## Estado atual

O runtime health, a rebaseline documental e o container/Compose de produção
foram incorporados pelos PRs #29 e #31. A CI essencial e a publicação GHCR
foram incorporadas pelo PR #32 no squash
`c02af719c72277f49348de33762ff12dc589434d`. A correção de identidade remota e
evidências foi incorporada pelo PR #33 no squash
`c6fbc0b865540abd9d13f93c7cc7542eb0936355`; a execução pós-merge
`31249557339` aprovou validação, runtime, scan local, push, identidade remota,
package público, rescan por digest e artifact. Isso comprova imagens públicas,
não uma produção operacional: nenhuma infraestrutura da aplicação foi
implantada e nenhum deploy foi realizado. A VPS Hostinger KVM 2 já
foi contratada e é o destino previsto; seu inventário, configuração e adequação
à topologia do MVP ainda precisam ser comprovados. O estado de DNS, origem,
Vercel, Traefik, PostgreSQL da aplicação, secrets, backup, restore,
monitoramento e deploy ainda não foi comprovado, configurado ou validado para
esta baseline. Nenhum dado real está autorizado.

O target `production` do Dockerfile e `compose.production.yml` definem a stack
base incorporada pela `0.8-MVP-03`. A imagem foi publicada somente no GHCR e a
stack foi validada em Docker Desktop com dados sintéticos; nada foi implantado
na VPS ou autorizado para dados reais. `compose.yml` e
`compose.test.yml` permanecem superfícies separadas de desenvolvimento e teste.

A candidata `0.8-MVP-05A` preserva a imagem já publicada da API e altera apenas
artefatos não image-affecting. Ela versiona o contrato necessário antes da
instalação: três roles PostgreSQL, secrets file-backed, imagens por digest,
identidade estável do projeto/volume e bundle mínimo. Nada foi transferido à
VPS e nenhum volume, secret ou serviço persistente foi criado.

## Arquitetura

```text
Navegador
→ frontend na Vercel em app.<domínio>
→ proxy same-origin de /api/v1
→ origem HTTPS protegida em origin-api.<domínio>
→ Traefik
→ uma instância da API NestJS
→ PostgreSQL 17 em rede privada
```

O navegador usa apenas paths relativos `/api/v1`. Preview não recebe a origem
de produção e falha fechado. Somente o Traefik publica a origem; as portas da
API e do PostgreSQL não possuem exposição direta. Forwarded headers e
`TRUST_PROXY_HOPS` serão ajustados e testados contra a topologia real.

Os hostnames finais são **PENDING HUMAN DECISION**.

## Serviços

A VPS Hostinger KVM 2 dedicada já foi contratada como destino da infraestrutura
inicial, com plano de 2 vCPU, 8 GB de RAM e 100 GB NVMe. Capacidade disponível,
serviços, redes, portas, volumes e configurações ainda dependem de inventário e
validação operacional.

| Serviço       | Responsabilidade                                     | Estado                                                 |
| ------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| VPS Hostinger | hospedar a stack mínima do MVP                       | contratada; inventário e configuração pendentes        |
| Vercel        | frontend e proxy same-origin de `/api/v1`            | estado de produção ainda não comprovado                |
| Traefik       | HTTPS e único ingresso público da origem             | configuração para o MVP ainda não comprovada           |
| API NestJS    | contratos de sessão, tenant, CRM e runtime health    | código local; stack de produção ainda não validada     |
| PostgreSQL 17 | persistência privada, roles e migrations             | estado para a aplicação ainda não comprovado           |
| Backup        | cópia recuperável separada da persistência principal | provedor pendente; configuração ainda não comprovada   |
| Monitoramento | uptime, recursos, logs, health e backup              | ferramenta pendente; configuração ainda não comprovada |

Redis, n8n, Evolution API, Portainer e outros serviços só entram quando uma
funcionalidade do MVP demonstrar dependência real. A primeira topologia usa
uma réplica da API enquanto rate limits e semáforos forem process-local.

### Container e Compose de produção

A stack base possui somente `postgres`, `migrate` e `api`, sob o projeto fixo
`genesis`. API e migration usam exatamente a imagem
`ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659`;
PostgreSQL usa o índice oficial
`postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`,
cuja variante `linux/amd64` é
`sha256:af194ccf3e2d7fe367012c7b88ce8b816c5c889b18a5b316799a1f0d7eac746a`.
Tags e `build:` são proibidos. A API e o PostgreSQL não publicam portas; a API
declara apenas exposição interna na porta 3000.

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

Até a `0.8-MVP-08`, `FRONTEND_URL=https://genesis.invalid` é uma origem
deliberadamente não resolvível e não representa o domínio final.

A rede `edge` conecta somente a API e reserva a interface futura para o
Traefik; nenhuma porta, label ou configuração de Traefik pertence a esta
tarefa. O `invitation-worker` permanece implementado no produto, mas não faz
parte da stack base de produção.

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

## CI e imagem

A `0.8-MVP-04` divide a CI em `validate`, `image-impact`, `build-and-scan` e
`publish-image`, todos em `ubuntu-24.04`. `validate` preserva o perfil completo e
acrescenta contratos da CI, os 34 testes focados de produção e validação real
do Compose com valores sintéticos. Em Pull Requests e execuções manuais,
`build-and-scan` produz uma única imagem local do target `production` para
`linux/amd64` e a submete ao Trivy antes de terminar, sem login ou publicação.

A correção `0.8-MVP-05A-CORR-01` mantém esse desenho e alinha a validação
sintética ao contrato versionado: matriz não secreta completa, três roles
PostgreSQL distintas, referências imutáveis, frontend canônico e versão do
keyring de Leads. Os seis valores sintéticos ficam somente em arquivos `0600`
sob `runner.temp`; um override transitório é usado apenas para renderizar o
Compose, não é enviado como artifact e é removido imediatamente após a
validação canônica, inclusive quando um passo anterior falha.

Todo `push` da `main` continua executando `validate`. O job não privilegiado
`image-impact`, também limitado a esse evento e com somente `contents: read`,
compara os commits completos `before` e `head`. `publish-image` depende dos
dois jobs e somente é autorizado quando ambos terminam com sucesso e o detector
emite exatamente `should_publish=true`. Falha de Git, SHA inválido, range não
resolvido ou saída ambígua deixa o workflow vermelho e impede login, build e
push. Mudança apenas documental, operacional, de Compose, CI, scripts ou testes
emite `false`, portanto a própria correção do filtro não publica imagem.

Os paths canônicos que podem alterar a imagem são `Dockerfile`, `.dockerignore`,
`.npmrc` quando rastreado, `package.json`, `package-lock.json`, `nest-cli.json`,
`tsconfig.json`, os demais `tsconfig*.json` legítimos na raiz e `src/**`,
incluindo as migrations versionadas atuais. A lista deve ser revista junto com
o Dockerfile sempre que mudarem entradas de dependências, build Nest, geração
de `dist`, migrations embarcadas ou arquivos copiados para o runtime final; o
mesmo delta deve atualizar detector, testes, validator da CI e este documento.

Somente um `push` impactante da `main` habilita `publish-image`, com
`contents: read` e `packages: write` limitados ao job. A identidade canônica é
`ghcr.io/arthurportodev/genesis-platform-api:sha-<SHA completo>`. O fluxo de tag
nova constrói uma vez, carrega, registra o config digest local, verifica as seis
labels OCI, bloqueia toda vulnerabilidade Critical e revalida esse config digest
imediatamente antes do único push. O digest reportado pelo push forma a
referência imutável. A correção `0.8-MVP-04-CORR-01` separa as fontes de
identidade: `.Manifest` fornece somente o digest do descriptor,
`imagetools inspect --raw` fornece `config.digest` e `.Image` fornece plataforma
e labels OCI. O fluxo de tag existente não reconstrói nem sobrescreve; ambos os
caminhos verificam identidade, package e tag, fazem novo scan da referência
remota por digest e só então geram a evidência.

`image-identity.json`, retido por 14 dias e criado em modo `0600`, registra
repositório, visibilidade, tag, manifest e config digests, referência imutável,
commit, run, plataforma, labels OCI completas, scanner, resultado do rescan e
vínculo package/repositório. A referência autoritativa para deploy e rollback é
`ghcr.io/arthurportodev/genesis-platform-api@sha256:<digest>`. Não existem tags
`latest` ou `main`; provenance, SBOM, assinatura, multiarch e cache remoto de
build permanecem fora desta entrega.

Arthur aprovou manter público o package
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
O marcador visual “Latest” do GitHub não é uma tag `latest`. O package não será
excluído, recriado ou tornado privado por esta correção.

O runtime final usa `alpine:3.24`; `node:24-alpine3.24` fica restrito aos
estágios que executam npm e build. A imagem final recebe somente o executável
Node, `libstdc++`, dependências podadas, `dist` e `package.json`. npm, npx, Yarn,
Corepack, módulos globais e o pacote npm `tar` não entram no runtime. O contrato
estrutural e a inspeção da imagem real verificam esse limite antes do Trivy e de
qualquer push, tanto no caminho de imagem nova quanto em rerun por digest.

Essa entrega não depende de cadeia customizada de evidências. Controles
avançados de supply chain são backlog pós-MVP.

## Deploy manual

O fluxo inicial é:

1. selecionar commit aprovado e CI essencial verde;
2. publicar ou selecionar a imagem no GHCR por tag do commit e digest;
3. obter aprovação humana para a execução;
4. validar o bundle, criar o volume externo separadamente e confirmar secrets,
   persistência, backup recuperável e capacidade da VPS;
5. executar uma migration controlada com credencial própria;
6. iniciar ou atualizar uma réplica da API atrás do Traefik;
7. validar health, logs e smoke sintético;
8. manter o novo digest ou executar rollback.

O deploy permanece manual e documentado. Nenhuma etapa deste documento prova
que a operação já ocorreu.

## Migrations

Migrations versionadas são a única fonte do schema; `synchronize` e
`migrationsRun` permanecem desabilitados. A role de migration é separada e sua
credencial não fica disponível ao runtime. O job de migration é único e
bloqueante. Rollback da aplicação não reverte schema automaticamente; uma
migration incompatível exige plano específico antes do deploy.

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
fechada: Compose, configuração não secreta renomeada, init PostgreSQL, dois
wrappers e `release-manifest.json`. Existem exatamente dois modos:

- `candidate` é não operacional, copia a worktree somente para validação local
  e registra `baseSha`, `candidateId` e `contentFingerprint`. Ele não declara
  `sourceCommit` e nunca pode ser usado em VPS;
- `committed-release` é operacional, exige um commit real, lê cada artefato do
  snapshot Git declarado e falha se path, blob, mode ou bytes correspondentes
  da worktree divergirem. Somente esse modo pode ser transferido em uma tarefa
  futura.

O manifesto também registra hashes, modes, digests, `linux/amd64`, versão do
contrato e timestamp reproduzível derivado do commit de referência ou de
`SOURCE_DATE_EPOCH`; ele não representa o relógio real do deploy.
`scripts/validate-production-bundle.cjs` rejeita arquivo extra, artefato
irregular, binding divergente, candidate usado como release, proveniência Git
incompleta, tag, path `.env` e conteúdo secret-like. A validação operacional
deve usar `--require-mode committed-release`.

Os cinco artefatos do bundle usam mode Git/manifest `0644`. Os wrappers de API
e migration não dependem de execute bit porque o Compose os chama
explicitamente por `/bin/sh`. O init PostgreSQL também não depende de execute
bit: o
[`docker-entrypoint.sh` oficial congelado](https://github.com/docker-library/postgres/blob/4f9ced003ba58a854656ba150d146243d27ae3ac/docker-entrypoint.sh#L158-L188)
faz `source` de todo `.sh` não executável encontrado em
`/docker-entrypoint-initdb.d`. Mode `0755` ou qualquer outro mode diverge do
contrato e bloqueia `committed-release`.

Nenhum bundle desta tarefa é transferido à VPS. Uma entrega futura deve gerar
o modo `committed-release` automaticamente depois do commit aprovado.

## Backup e restore

Backup de PostgreSQL é obrigatório antes de dados reais e deve ser protegido
contra perda junto com a VPS. O provedor, frequência e retenção são
**PENDING HUMAN DECISION**. Secrets de backup não entram no repositório nem em
logs.

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
TLS e execução de backups. A ferramenta é **PENDING HUMAN DECISION**.

## Frontend e proxy

O frontend permanece na Vercel e usa proxy server-side same-origin para
`/api/v1`. O proxy preserva cookies, status, body e headers contratuais, aplica
`no-store` nas respostas sensíveis e impede que o fallback da SPA responda por
rotas da API. Preview não usa a origem de produção. Cookies continuam
host-only conforme o [ADR-010](decisions/ADR-010-web-session-contract.md).

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

## Decisões humanas pendentes

- domínio e subdomínios finais;
- provedor, frequência e retenção de backup;
- ferramenta de monitoramento;
- momento de autorizar os primeiros dados reais.

Até decisão explícita, use somente `app.<domínio>` e
`origin-api.<domínio>` como placeholders.
