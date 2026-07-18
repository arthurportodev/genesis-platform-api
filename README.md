# Genesis Platform API

Backend da Genesis Platform, um SaaS de CRM e operação comercial multiempresa. Esta versão contém somente a fundação técnica: aplicação NestJS, configuração validada, PostgreSQL, health check, Docker e testes. Autenticação e módulos de negócio ainda não fazem parte do projeto.

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
```

Os comandos carregam as variáveis do `.env`. Nenhuma tabela de domínio foi criada nesta fundação.

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
│   └── typeorm.options.ts
└── health/
    ├── health.controller.ts
    ├── health.module.ts
    └── health.service.ts
```

Diretórios vazios para abstrações futuras não foram criados. Os próximos módulos de negócio deverão ser adicionados em `src/modules/` quando houver uma tarefa que os implemente.

## Decisões técnicas

- **Monólito modular:** mantém o início simples e permite separar responsabilidades conforme o produto crescer.
- **TypeORM:** integração nativa com NestJS, driver PostgreSQL maduro e suporte direto a migrations versionadas.
- **Schema sem sincronização automática:** `synchronize` permanece desabilitado em todos os ambientes; migrations serão a fonte de verdade.
- **Configuração centralizada:** `@nestjs/config` e Joi validam o ambiente; os consumidores usam `ConfigService`.
- **Health check explícito:** uma consulta `SELECT 1` confirma a dependência real do PostgreSQL.
- **Swagger adiado:** será mais útil quando existirem endpoints de negócio e seus DTOs.

## Problemas comuns

- **Falha de validação ao iniciar:** compare o `.env` com `.env.example` e confirme que não há valores vazios.
- **Banco desconectado fora do Docker:** use `DATABASE_HOST=localhost` e confirme porta, usuário e banco.
- **Banco desconectado no Docker:** use `DATABASE_HOST=postgres`; não use `localhost` dentro do container da API.
- **Porta ocupada:** altere `PORT` no `.env`.
- **Versão incompatível do Node:** execute `nvm use` ou instale Node 24.

## Próximos módulos previstos

Em tarefas futuras: organizações, usuários, memberships, convites, autenticação e, posteriormente, módulos de CRM e integrações. A estratégia de isolamento multi-tenant deve ser definida antes das primeiras tabelas de domínio.
