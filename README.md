# Genesis Platform API

Backend da Genesis Platform, um SaaS de CRM e operação comercial multiempresa. Esta versão contém a fundação técnica e o núcleo persistente multi-tenant: usuários, organizações e vínculos. Autenticação e demais módulos de negócio ainda não fazem parte do projeto.

## Pré-requisitos

- Node.js 24 (consulte `.nvmrc`)
- npm 11 ou superior
- PostgreSQL 17 para execução sem Docker
- Docker com Docker Compose v2 para execução em containers

## Configuração

Instale as dependências e crie o arquivo de ambiente:

```bash
npm ci
cp .env.example .env
```

O `.env.example` usa `DATABASE_HOST=postgres`, nome do serviço no Compose. Para executar a API diretamente na máquina, altere esse valor no `.env` para `localhost`.

Todas as variáveis declaradas no exemplo são validadas na inicialização. A aplicação encerra com uma mensagem clara se um valor obrigatório estiver ausente ou inválido. Nunca versione o arquivo `.env`.

## Execução sem Docker

Inicie um PostgreSQL local, configure o `.env` e execute:

```bash
npm run start:dev
```

Para compilar e executar o artefato de produção:

```bash
npm run build
npm run start:prod
```

## Execução com Docker

Com um `.env` criado a partir do exemplo:

```bash
npm run docker:up
npm run docker:logs
```

O Compose constrói a API, inicia PostgreSQL 17 com volume persistente, aguarda o banco ficar saudável e expõe somente a porta da API. Para encerrar:

```bash
npm run docker:down
```

Para apagar também os dados locais do PostgreSQL, execute conscientemente `docker compose down -v`.

## Health check

```http
GET http://localhost:3000/api/v1/health
```

Resposta saudável (`200`):

```json
{
  "status": "ok",
  "service": "genesis-platform-api",
  "version": "0.1.0",
  "database": "connected",
  "timestamp": "2026-07-18T12:00:00.000Z"
}
```

Quando o PostgreSQL não responde, o endpoint retorna `503`, `status: "error"` e `database: "disconnected"`, sem expor detalhes internos.

## Qualidade e testes

```bash
npm run lint
npm run format:check
npm run build
npm run test
npm run test:e2e
```

Os testes unitários e e2e usam mocks da conexão, portanto não precisam de credenciais nem de um banco real.

## Migrations

O projeto usa TypeORM com `synchronize: false`. Toda alteração futura de schema deve ser registrada em migration.

```bash
# Criar uma migration vazia
npm run migration:create -- src/database/migrations/CreateExample

# Gerar uma migration após adicionar entidades
npm run migration:generate -- src/database/migrations/CreateExample

# Aplicar ou reverter migrations
npm run migration:run
npm run migration:revert

# Consultar migrations aplicadas e pendentes
npm run migration:show
```

Os comandos carregam as variáveis do `.env`. `synchronize` permanece desabilitado: a migration versionada é a única fonte de verdade do schema.

Os scripts recompilam automaticamente quando as ferramentas de desenvolvimento estão instaladas e reutilizam o artefato já compilado dentro da imagem. Portanto, os mesmos comandos funcionam no container:

```bash
docker compose exec api npm run migration:run
docker compose exec api npm run migration:show
```

## Modelo multi-tenant

```text
users
  1
  │
  │
  N
memberships
  N
  │
  │
  1
organizations
```

- `users` representa uma pessoa globalmente. O email é único e normalizado em letras minúsculas.
- `organizations` representa cada empresa. O slug é único, minúsculo e adequado para URL.
- `memberships` liga um usuário a uma organização e armazena o papel e o status daquele vínculo.

Um usuário pode participar de várias organizações, com papéis diferentes em cada uma. Uma organização pode possuir vários usuários. O par `user_id + organization_id` é único.

Papéis disponíveis em memberships:

- `owner`
- `admin`
- `member`

Status disponíveis para usuários, organizações e memberships:

- `active`
- `inactive`

Todas as tabelas usam UUID gerado pelo PostgreSQL, `created_at` e `updated_at` com timezone. As foreign keys de membership utilizam `RESTRICT`: usuários ou organizações com vínculos não são removidos acidentalmente. O fluxo futuro deve priorizar desativação por status.

## Seed inicial

Após aplicar as migrations, execute manualmente:

```bash
npm run seed
```

O seed cria, dentro de uma transação:

- organização `Agência Gênesis`, slug `agencia-genesis`;
- usuário `Arthur Porto`, email `contato@agenciagenesismkt.com.br`;
- membership com papel `owner` e status `active`.

O seed não executa durante a inicialização da API e é idempotente. Uma segunda execução localiza os três registros existentes e não cria duplicações.

No container, execute o mesmo script:

```bash
docker compose exec api npm run seed
```

## Testes com PostgreSQL isolado

Os testes de integração nunca aceitam um banco cujo nome não termine em `_test`. O arquivo `compose.test.yml` inicia PostgreSQL separado, descartável, na porta local 5433 e usa `tmpfs`.

```bash
npm run test:db:up
npm run test:integration
npm run test:db:down
```

Esse teste valida migration em banco vazio, rollback, nova migration, enums, constraints, índices, foreign keys, seed e idempotência. Nunca aponte `TEST_DATABASE_*` para o banco de desenvolvimento.

## Estrutura inicial

```text
src/
├── app.module.ts
├── main.ts
├── common/
│   └── filters/http-exception.filter.ts
├── config/
│   ├── app.config.ts
│   ├── configuration.module.ts
│   ├── database.config.ts
│   └── environment.validation.ts
├── database/
│   ├── data-source.ts
│   ├── database.module.ts
│   ├── migrations/
│   ├── seeds/
│   ├── typeorm-base.options.ts
│   └── typeorm.options.ts
├── health/
    ├── health.controller.ts
    ├── health.module.ts
    └── health.service.ts
└── modules/
    ├── memberships/
    ├── organizations/
    └── users/
```

Não existem controllers, services vazios, DTOs ou repositórios genéricos para esses módulos. Esta etapa implementa somente persistência.

## Decisões técnicas

- **Monólito modular:** mantém o início simples e permite separar responsabilidades conforme o produto crescer.
- **TypeORM:** integração nativa com NestJS, driver PostgreSQL maduro e suporte direto a migrations versionadas.
- **Schema sem sincronização automática:** `synchronize` permanece desabilitado em todos os ambientes; migrations serão a fonte de verdade.
- **Configuração centralizada:** `@nestjs/config` e Joi validam o ambiente; os consumidores usam `ConfigService`.
- **Health check explícito:** uma consulta `SELECT 1` confirma a dependência real do PostgreSQL.
- **UUID no PostgreSQL:** `gen_random_uuid()` mantém a geração consistente inclusive em inserts fora do TypeORM. A migration habilita `pgcrypto` quando necessário e o rollback não remove a extensão, pois ela pode ser compartilhada.
- **Exclusão conservadora:** FKs `RESTRICT` impedem que exclusões de user/organization removam silenciosamente memberships ou entidades do outro lado.
- **Swagger adiado:** será mais útil quando existirem endpoints de negócio e seus DTOs.

## Problemas comuns

- **Falha de validação ao iniciar:** compare o `.env` com `.env.example` e confirme que não há valores vazios.
- **Banco desconectado fora do Docker:** use `DATABASE_HOST=localhost` e confirme porta, usuário e banco.
- **Banco desconectado no Docker:** use `DATABASE_HOST=postgres`; não use `localhost` dentro do container da API.
- **Porta ocupada:** altere `PORT` no `.env`.
- **Versão incompatível do Node:** execute `nvm use` ou instale Node 24.

## Próximos módulos previstos

Em tarefas futuras: autenticação, convites, escolha da organização ativa, autorização por tenant e, posteriormente, módulos de CRM e integrações. Nenhuma dessas funcionalidades foi antecipada nesta etapa.
