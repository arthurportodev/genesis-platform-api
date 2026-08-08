# ADR-014 — Contrato versionado de PostgreSQL, secrets e bundle

- **Status:** Accepted
- **Data:** 2026-08-08

## Contexto

O Compose incorporado na `0.8-MVP-03` separava runtime de migration, mas usava
`POSTGRES_USER` como migration owner. Na imagem oficial isso torna a migration
superuser e mantém bootstrap/admin e migration como uma única identidade.
Secrets também eram interpolados em `environment`, a imagem PostgreSQL usava
tag mutável e a identidade física do volume dependia do projeto Compose.

Antes de instalar a stack na VPS, esses limites precisam ser corrigidos em um
contrato local verificável, sem alterar a imagem atual da API e sem criar
infraestrutura, secrets ou dados persistentes.

## Decisão

### PostgreSQL

Existem três nomes seguros e distintos, sem memberships entre si:

- bootstrap/admin: superuser somente para init e recuperação excepcional;
- migration: `LOGIN`, owner do database/schema e explicitamente
  `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`;
- runtime: `LOGIN`, sem ownership e com os mesmos atributos negativos.

O init só aceita volume vazio, falha se migration/runtime já existirem,
transfere ownership para migration, revoga privilégios do database/schema de
`PUBLIC` e comprova atributos, memberships e ownership. `pgcrypto` continua
instalável pela migration owner. Grants funcionais do runtime pertencem às
migrations versionadas. `migration:revert` não é rollback operacional.

### Secrets

Secrets são arquivos individuais montados seletivamente pelo Compose. Valores
não entram em `environment`, `.env`, argumentos, labels, logs, manifestos,
evidências ou Git. O contrato futuro do host usa diretório root-only, arquivos
`root:genesis-container-secrets` `0440`, GID 70 e nenhum membro humano.

API e migration recebem GID suplementar 70. Wrappers POSIX read-only leem
paths constantes, validam missing/vazio, removem exatamente um newline
terminal, preservam caracteres especiais, exportam apenas os nomes existentes
e terminam com `exec`. PostgreSQL usa `POSTGRES_PASSWORD_FILE`.

Subconjuntos:

- postgres: bootstrap, migration e runtime database passwords;
- migration: somente migration password;
- API: runtime password, JWT secret, refresh pepper e Lead idempotency keyring.

### Identidade e persistência

- projeto Compose: `genesis`;
- plataforma: `linux/amd64`;
- API: digest canônico `sha256:56ada3e6...`;
- PostgreSQL: índice oficial `sha256:742f40ea...`, variante amd64
  `sha256:af194ccf...`;
- volume físico externo: `genesis-postgres-data`;
- shutdown: API 20 segundos, PostgreSQL 90 segundos;
- frontend temporário: `https://genesis.invalid`, substituído na 0.8-MVP-08.

O volume deve ser criado explicitamente pela `0.8-MVP-05B`. Ausência bloqueia
o Compose, e `down -v` não o remove.

### Bundle

Um builder determinístico copia somente Compose, configuração não secreta,
init e wrappers para um diretório novo. O contrato v2 separa dois modos:

- `candidate`, não operacional e vinculado a `baseSha`, `candidateId` e
  `contentFingerprint` da worktree; não contém `sourceCommit`;
- `committed-release`, operacional e vinculado a um commit que contém todos os
  paths com blobs e modes idênticos. Os bytes são lidos do snapshot Git, e
  drift correspondente na worktree bloqueia build e validação.

O release manifest também registra hashes, digests, plataforma, versão do
contrato e timestamp derivado do commit de referência ou `SOURCE_DATE_EPOCH`.
O validator rejeita tags, arquivo esperado ausente, extra, entrada irregular,
hash divergente, binding divergente, proveniência Git incompleta, candidate
usado como release e conteúdo secret-like. Somente `committed-release`,
validado com requisito explícito desse modo, pode ser usado em VPS.

Todos os artefatos usam mode Git/manifest `0644`. Os wrappers são invocados
explicitamente por `/bin/sh`; o init PostgreSQL `.sh` sem execute bit é lido
com `source` pelo entrypoint oficial da imagem congelada. Assim, a identidade
do commit não exige transição posterior de mode, e `0755` também é tratado como
drift fail-closed.

Nenhum bundle é transferido nesta tarefa.

## Consequências

O contrato reduz privilégio persistente, exposição de secrets em metadata,
drift de imagem e risco de remoção acidental do volume. Em contrapartida, exige
pré-criação controlada de grupo, arquivos e volume, além de rotação explícita
porque init scripts oficiais não reexecutam em volumes existentes.

## Fora do escopo

Instalação Docker, layout/permissions reais, geração/custódia de secrets,
volume persistente, migrations/VPS, deploy, Traefik, HTTPS, DNS, backup,
monitoramento, Git remoto e publicação GHCR permanecem fora desta decisão.

## Relações

- Especializa o [ADR-013](ADR-013-mvp-production-baseline.md).
- A operação futura permanece condicionada a [PRODUCTION.md](../PRODUCTION.md).
- A origem definitiva pertence à `0.8-MVP-08`.
