# Plano canônico de produção

Este documento é a autoridade operacional sobre a arquitetura geral da
primeira produção, Hetzner, Traefik, API, PostgreSQL, migrations, roles,
secrets, keyrings, imagens, GHCR, backup, restore, observabilidade, deploy da
API, bootstrap, abertura controlada e o DAG da Fase `0.8`. O frontend mantém a
autoridade específica sobre Vercel, proxy same-origin, Preview, cookies,
headers web, publicação e rollback em seu próprio `docs/PRODUCTION.md`.

## Estado atual

A decisão arquitetural foi aceita pelo Product Owner em 30 de julho de 2026,
mas ainda não foi implementada. Não existem banco de produção, manifests
aprovados, imagem publicada no GHCR, secrets instalados, DNS, projeto Vercel,
Traefik configurado para esta aplicação, backup externo, restore comprovado,
observabilidade ou deploy. O Compose atual é uma superfície de desenvolvimento
e validação, não um manifesto de produção aprovado. A aplicação não está pronta
para dados reais.

## Arquitetura alvo

```text
Navegador
→ https://app.agenciagenesis.com.br
→ Vercel
→ proxy server-side de /api/v1
→ https://origin-api.agenciagenesis.com.br
→ Traefik
→ API NestJS (uma réplica pública)
→ PostgreSQL 17 dedicado
```

O frontend permanece na Vercel e o backend na Hetzner. O navegador usa somente
paths relativos `/api/v1`; Preview nunca acessa produção. A origem é HTTPS,
server-only para o frontend e protegida contra bypass. A primeira produção usa
uma única réplica pública da API enquanto rate limits e semaphores forem
process-local.

## Responsabilidades por serviço

| Serviço               | Responsabilidade                                                            | Estado                                      |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| Vercel                | SPA, domínio `app`, proxy `/api/v1`, headers e rollback web                 | Aprovado; não configurado                   |
| Traefik               | TLS da origem, roteamento exclusivo, forwarded headers e proteção de bypass | Aprovado; não configurado                   |
| API NestJS            | Contratos `/api/v1`, autenticação, tenant, CRM e health                     | Código existente; stack de produção ausente |
| PostgreSQL 17         | Persistência dedicada, roles separadas e volume próprio                     | Aprovado condicionalmente; não provisionado |
| GHCR privado          | Imagens por SHA e digest, com scan e evidência de build                     | Aprovado; não configurado                   |
| Armazenamento externo | Backups criptografados fora do failure domain da VPS                        | Obrigatório; provedor não escolhido         |
| Monitoramento         | Uptime, VPS, containers, banco, disco, TLS, migrations e backups            | Obrigatório; ferramenta não escolhida       |

## Domínios, redes e portas

- `app.agenciagenesis.com.br`: domínio público do frontend na Vercel.
- `origin-api.agenciagenesis.com.br`: origem HTTPS protegida da API.
- Apenas Traefik publica a origem e encaminha para a rede interna da API.
- A porta `3000` da API não possui publicação direta.
- A porta `5432` do PostgreSQL não possui bind público.
- API, migration job e PostgreSQL usam redes internas com acessos mínimos.
- `TRUST_PROXY_HOPS` e forwarded headers são validados contra a topologia real;
  confiança irrestrita é proibida.

Nenhum IP real ou URL administrativa pertence a esta documentação. O
inventário deve confirmar rede, portas ocupadas, firewall, Traefik existente e
capacidade antes do provisionamento.

## PostgreSQL e roles

A opção inicial é PostgreSQL 17 em container dedicado na mesma VPS Hetzner,
com volume dedicado, rede interna e sem bind público. Ela depende do inventário
comprovar capacidade, segurança, armazenamento, backup e ausência de conflito
operacional. Se a VPS for insuficiente, reavaliar VPS separada ou PostgreSQL
gerenciado.

A role LOGIN da API runtime permanece distinta da role proprietária usada por
migrations. A runtime recebe somente os privilégios já definidos pelas
migrations e não pode assumir owner, `SUPERUSER` ou `BYPASSRLS`. A credencial
de migration existe apenas durante o job controlado e não fica disponível ao
container da API.

## Migrations

Migrations versionadas continuam sendo a única fonte do schema;
`synchronize` e `migrationsRun` permanecem desabilitados. Cada deploy usa um
job único de migration, com imagem por digest, credencial temporária de owner,
log sanitizado e resultado bloqueante. A API só inicia ou é promovida após a
conclusão comprovada do job. Rollback de aplicação não reverte schema
automaticamente; qualquer migration incompatível exige plano próprio e Gate.

## Secrets e keyrings

A estratégia aprovada é secret files ou cofre. Se nenhum mecanismo auditado
estiver disponível, o fallback é um arquivo root-owned com permissão `0600`,
fora do Git, da imagem e dos logs. Secrets são independentes por finalidade e
ambiente; valores reais nunca entram em documentação, CLI gravada, Compose
versionado ou variáveis `VITE_*`.

Keyrings preservam todas as versões ainda necessárias a invitations,
idempotência e dados existentes. Rotação inclui inventário de versões,
instalação da nova chave, validação de readiness, mudança controlada da versão
ativa e retirada somente quando nenhuma referência válida depender da versão
antiga. Recuperação e rotação precisam de runbook testado.

## Imagens e registry

O registry aprovado é o GitHub Container Registry privado. Cada imagem é
identificada por commit SHA, versão e digest imutável, acompanhada de scan e
evidência de build. O deploy e o rollback fixam digest; `latest` pode existir
como conveniência, mas nunca é fonte de verdade. Credenciais de pull possuem o
menor escopo e não são incorporadas à imagem.

## Backup e restore

O backup inicial usa `pg_dump --format=custom`, criptografia e envio para
armazenamento externo à VPS e fora do mesmo failure domain. A frequência
inicial planejada é de seis horas; retenção será revisada após inventário e
necessidade operacional. Backup atrasado gera alerta. Snapshot Hetzner é apenas
camada adicional e não substitui o backup lógico externo.

Antes de qualquer dado real, um restore sintético deve comprovar download,
decriptação, integridade, restauração em banco isolado, aplicação das
migrations esperadas, health e consultas de smoke. O provedor de object storage
ainda não foi escolhido.

## Observabilidade

A primeira produção exige uptime externo, métricas da VPS, containers,
PostgreSQL e disco; alertas de reinício, indisponibilidade, TLS, migrations e
backup atrasado; e logs estruturados sem secrets, tokens, cookies ou PII. Uma
solução existente só pode ser reutilizada depois de auditada. A ferramenta
específica ainda não foi escolhida.

## Deploy da API

O deploy será manual e controlado inicialmente:

1. validar inventário, Gate e candidato imutável;
2. confirmar backup recente e capacidade de restore;
3. baixar a imagem pelo digest aprovado;
4. executar o migration job com credencial temporária;
5. iniciar uma réplica da API na rede interna;
6. validar health interno e logs;
7. habilitar ou atualizar o router Traefik da origem;
8. executar smoke sintético e observar alertas.

Nenhuma tarefa anterior a `0.8.4` executa deploy remoto. Convites e email ficam
desabilitados na primeira abertura.

## Rollback

Rollback de aplicação fixa o digest anterior validado, preserva a mesma rede e
reexecuta health e smoke. Mudanças de Traefik e DNS mantêm configurações
anteriores recuperáveis. Migration aditiva compatível permite rollback do
runtime; migration incompatível exige procedimento específico e não é revertida
automaticamente. Perda ou corrupção de dados aciona o runbook de restore, não
uma tentativa improvisada sobre o banco ativo.

## Ambientes e Preview

- **Local/teste:** recursos locais ou descartáveis; nenhum dado real.
- **Preview:** interface Vercel fail-closed em `/api/v1`, sem variável de origem
  de produção.
- **Production:** domínio `app`, proxy server-side e origem protegida.
- **Staging:** não será criado inicialmente.

## Bootstrap seguro

A tarefa `0.8.10` cria a primeira Organization e o owner
`contato@agenciagenesismkt.com.br` por processo manual e auditável. A senha
temporária entra somente no processo de bootstrap, nunca neste documento, no
Git, na imagem ou no ambiente permanente da API. Após primeiro acesso, a
credencial é substituída e o segredo inicial removido. Não há Leads reais,
convites ou email nessa etapa.

## Abertura controlada

A sequência de abertura é infraestrutura → dados sintéticos → owner → equipe
interna → novas Organizations. Cada etapa exige smoke, observabilidade e
rollback disponíveis. Dados reais entram somente depois de restore testado,
smoke sintético completo, alertas ativos, origem protegida, portas internas
bloqueadas, rotação da credencial inicial e aprovação humana específica.

## Tarefas da Fase 0.8

| Tarefa   | Resultado                                            | Dependências principais                          |
| -------- | ---------------------------------------------------- | ------------------------------------------------ |
| `0.8.0`  | Gate 1 técnico read-only e plano recomendado         | —                                                |
| `0.8.1`  | Documentação e decisões canônicas                    | `0.8.0` e aprovação humana                       |
| `0.8.2`  | Hardening e imagem da API, sem deploy                | `0.8.1`                                          |
| `0.8.3`  | Banco, roles, migrations, backup e restore sintético | inventário da VPS, `0.8.2`                       |
| `0.8.4`  | Stack interna da API na Hetzner                      | `0.8.2`, `0.8.3`                                 |
| `0.8.5`  | Origem, Traefik, TLS e firewall                      | `0.8.4`                                          |
| `0.8.6`  | Proxy e segurança do frontend, sem criar Vercel      | `0.8.1`, contrato aprovado da origem             |
| `0.8.7`  | Projeto Vercel sem domínio final                     | `0.8.6`                                          |
| `0.8.8`  | Domínio, DNS, TLS e cutover do app                   | `0.8.5`, `0.8.7`                                 |
| `0.8.9`  | Observabilidade, backup, restore drill e runbooks    | banco, API, origem, Vercel e domínio observáveis |
| `0.8.10` | Bootstrap seguro                                     | `0.8.9`, backup/restore e observabilidade        |
| `0.8.11` | Smoke e abertura controlada                          | `0.8.10`                                         |

## DAG canônico

```text
0.8.0 → 0.8.1
0.8.1 → 0.8.2
0.8.1 → 0.8.6
0.8.2 → 0.8.3
0.8.2 → 0.8.4
0.8.3 → 0.8.4
0.8.4 → 0.8.5
0.8.6 → 0.8.7
0.8.5 → 0.8.8
0.8.7 → 0.8.8
0.8.3 → 0.8.9
0.8.4 → 0.8.9
0.8.5 → 0.8.9
0.8.7 → 0.8.9
0.8.8 → 0.8.9
0.8.9 → 0.8.10
0.8.10 → 0.8.11
```

A tabela de dependências é normativa. O diagrama mostra `0.8.4` dependente de
`0.8.2` e `0.8.3`; `0.8.8` dependente de `0.8.5` e `0.8.7`; e `0.8.9`
aguardando infraestrutura suficiente para observação.

## Critérios de produção

### Tecnicamente publicada

Exige frontend, proxy, API, banco, TLS, domínio e health funcionando.

### Operacionalmente pronta

Exige também inventário da VPS/DNS/Vercel, banco privado, roles separadas,
migrations controladas, restore comprovado, imagem imutável, uma réplica
pública, Preview fail-closed, cookies/CSRF e trust proxy validados, origem
protegida, portas internas bloqueadas, secrets recuperáveis, backup externo,
observabilidade, rollback, owner com credencial substituída, smoke desktop e
mobile, teste cross-tenant e aprovação humana de abertura.

Publicação técnica não implica prontidão operacional.

## Dados pendentes do inventário

- capacidade de CPU, memória, disco, IOPS e espaço para crescimento da VPS;
- serviços, redes, portas, volumes e Traefik já existentes;
- firewall, DNS atual, acesso operacional e estratégia de manutenção;
- capacidade e isolamento necessários para PostgreSQL e backups locais;
- estado real do projeto/conta Vercel e da zona DNS.

## Decisões ainda não escolhidas

- provedor de object storage para backups;
- ferramenta de monitoramento;
- confirmação da capacidade da VPS para PostgreSQL dedicado na mesma máquina.
