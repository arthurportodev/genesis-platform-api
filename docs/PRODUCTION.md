# Produção do MVP

Este documento é a autoridade operacional da primeira produção da Genesis
Platform. A decisão arquitetural está no
[ADR-013](decisions/ADR-013-mvp-production-baseline.md). O objetivo é publicar o
produto existente para testes reais com segurança proporcional ao MVP, sem
antecipar uma infraestrutura definitiva.

## Objetivo

Operar uma instância pequena, compreensível e recuperável do frontend, da API e
do PostgreSQL. A abertura para usuários exige os controles mínimos deste
documento; requisitos avançados permanecem no backlog pós-MVP.

## Estado atual

O runtime health e a rebaseline documental foram incorporados à `main` pelo PR
#29 no squash `5e76b4fde61badce3a39792f7ba9e3ee6ea806ce`. A CI pós-merge
`30892867828` foi aprovada integralmente. Isso comprova o conteúdo incorporado,
mas não uma produção operacional: a infraestrutura da aplicação ainda não foi
publicada e nenhuma imagem foi publicada pelo merge. A VPS Hostinger KVM 2 já
foi contratada e é o destino previsto; seu inventário, configuração e adequação
à topologia do MVP ainda precisam ser comprovados. O estado de DNS, origem,
Vercel, Traefik, GHCR, PostgreSQL da aplicação, secrets, backup, restore,
monitoramento e deploy ainda não foi comprovado, configurado ou validado para
esta baseline. Nenhum dado real está autorizado.

O target `production` do Dockerfile e `compose.production.yml` definem a
candidata local da stack base da `0.8-MVP-03`. A imagem e a stack foram
validadas somente em Docker Desktop com dados sintéticos; não foram publicadas,
implantadas na VPS nem autorizadas para dados reais. `compose.yml` e
`compose.test.yml` permanecem superfícies separadas de desenvolvimento e teste.

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

A stack base possui somente `postgres`, `migrate` e `api`. Ela consome uma
imagem identificável obrigatória por `GENESIS_API_IMAGE`, sem `build:` no
Compose, e usa a mesma identidade para API e migration. A API e o PostgreSQL
não publicam portas; a API declara apenas exposição interna na porta 3000.

O PostgreSQL usa volume nomeado, rede interna de banco e role runtime distinta
da owner de migrations. O job de migration é one-shot, chama diretamente o
TypeORM compilado e bloqueia a API quando falha. A API usa filesystem read-only,
UID/GID fixos não-root, init, capabilities removidas, `no-new-privileges`,
readiness explícita e shutdown com tolerância externa de 20 segundos.

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

A CI essencial deve executar as validações proporcionais ao delta e produzir a
imagem Docker. A imagem aprovada será publicada no GHCR com tag do commit e terá
seu digest registrado. `latest` não é identidade suficiente para deploy ou
rollback. Credenciais de publicação e pull usam o menor escopo possível.

Essa entrega não depende de cadeia customizada de evidências. Controles
avançados de supply chain são backlog pós-MVP.

## Deploy manual

O fluxo inicial é:

1. selecionar commit aprovado e CI essencial verde;
2. publicar ou selecionar a imagem no GHCR por tag do commit e digest;
3. obter aprovação humana para a execução;
4. confirmar secrets, persistência, backup recuperável e capacidade da VPS;
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

Na imagem de produção, o job executa diretamente
`node node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run`.
Ele não recompila a aplicação, não depende do Nest CLI e não executa seed.

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
