# Genesis Platform API

Backend da Genesis Platform, um SaaS de CRM e operação comercial multiempresa. Esta versão contém a fundação técnica, o núcleo persistente multi-tenant e autenticação com sessões persistidas. A seleção da organização ativa e a autorização por papel continuam fora do escopo.

## Documentação do projeto

A memória oficial começa em [`docs/START_HERE.md`](docs/START_HERE.md). Consulte também o [estado atual](docs/CURRENT_STATE.md), o [roadmap](docs/ROADMAP.md), a [arquitetura](docs/ARCHITECTURE.md) e os [ADRs](docs/decisions/README.md).

O arquivo [`AGENTS.md`](AGENTS.md) define o protocolo obrigatório de reidratação e continuidade para agentes e desenvolvedores.

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

Variáveis de autenticação:

| Variável | Finalidade |
| --- | --- |
| `JWT_ACCESS_SECRET` | segredo aleatório com pelo menos 32 caracteres para assinar access tokens |
| `JWT_ACCESS_EXPIRES_IN` | duração curta no formato `15m`, `1h` etc. |
| `REFRESH_TOKEN_EXPIRES_IN_DAYS` | validade absoluta da sessão/refresh token |
| `REFRESH_TOKEN_PEPPER` | segredo aleatório usado no HMAC do refresh token |
| `INITIAL_OWNER_PASSWORD` | senha local usada somente quando o seed ainda precisa criar a credencial inicial |
| `AUTH_LOGIN_MAX_ATTEMPTS` | falhas permitidas por combinação de IP e email |
| `AUTH_LOGIN_IP_MAX_ATTEMPTS` | falhas agregadas permitidas por IP, independentemente do email |
| `AUTH_LOGIN_MAX_BUCKETS` | limite total de contadores mantidos em memória |
| `AUTH_LOGIN_WINDOW_SECONDS` | janela do limitador de login |
| `TRUST_PROXY_HOPS` | quantidade de proxies reversos confiáveis entre o cliente e a API (`0` por padrão) |

Substitua todos os placeholders antes de iniciar. Gere segredos independentes e fortes; nunca reutilize valores de desenvolvimento em produção. `INITIAL_OWNER_PASSWORD` nunca deve ser versionada, impressa em logs ou mantida com valor padrão.

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

`TRUST_PROXY_HOPS=0` ignora `X-Forwarded-For` e é o padrão seguro quando a API é acessada diretamente. Em uma implantação com um único Traefik confiável na frente da API, use `TRUST_PROXY_HOPS=1` e bloqueie o acesso externo direto à porta da API; nunca configure confiança irrestrita em proxies.

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
npm run test:integration
```

Os testes unitários e o E2E de health check usam mocks da conexão. O E2E de
autenticação e os testes de integração usam exclusivamente um PostgreSQL
descartável cujo nome termina em `_test`.

Para reproduzir localmente as mesmas verificações do CI:

```bash
npm ci
npm run test:db:up
npm run format:check
npm run lint
npm run build
npm run test -- --runInBand
npm run test:e2e -- --runInBand
npm run test:integration
docker build --tag genesis-platform-api:ci .
npm run test:db:down
```

## Integração contínua

O workflow `CI`, em `.github/workflows/ci.yml`, é executado em Pull Requests
destinados à `main`, pushes na `main` e por acionamento manual. Ele utiliza
Node.js 24, cache do npm, instalação limpa com `npm ci` e um service container
PostgreSQL 17 temporário para executar formatação, lint, build, testes unitários,
E2E, integração e o build da imagem de produção.

O banco do CI é descartável, não possui volume persistente e utiliza somente
credenciais de teste. O workflow tem permissão apenas de leitura do conteúdo do
repositório e não executa seed do proprietário, publicação de imagem ou deploy.

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

Após aplicar as migrations, execute manualmente. Na primeira execução, forneça a senha somente ao processo do seed, sem gravá-la no `.env` nem mantê-la no ambiente permanente da API:

```bash
docker compose exec -e INITIAL_OWNER_PASSWORD="<defina-localmente>" api npm run seed
```

O seed cria, dentro de uma transação:

- organização `Agência Gênesis`, slug `agencia-genesis`;
- usuário `Arthur Porto`, email `contato@agenciagenesismkt.com.br`;
- membership com papel `owner` e status `active`.

O seed não executa durante a inicialização da API e é idempotente. Uma segunda execução localiza os três registros existentes e não cria duplicações.

Se o usuário inicial ainda não possuir credencial, o seed também exige `INITIAL_OWNER_PASSWORD`, gera um hash Argon2id e registra apenas que a credencial foi criada. Se o hash já existir, ele não é substituído automaticamente e a variável deixa de ser obrigatória para essa execução.

Nunca execute o seed em produção com senha padrão. Defina a senha inicial por um canal seguro, execute o seed, confirme o acesso e substitua a credencial conforme a política operacional da equipe.

Quando a credencial inicial já existir, novas execuções idempotentes não exigem a variável e não substituem o hash existente:

```bash
docker compose exec api npm run seed
```

## Autenticação e sessões

A autenticação usa email e senha, Argon2id e dois tipos de token:

- **Access token:** JWT HS256 curto e configurável. O payload contém somente `sub`, `sessionId`, `type: access`, `iat` e `exp`.
- **Refresh token:** valor opaco e imprevisível no formato `sessionId.secret`. Somente o cliente recebe o token bruto; o PostgreSQL armazena HMAC-SHA-256 com `REFRESH_TOKEN_PEPPER`.

O hash de senha e o hash de refresh token não são selecionados pelo TypeORM por padrão e nunca fazem parte das respostas. O access token não contém organização, membership, papel ou permissão.

Cada login cria uma linha em `auth_sessions` e um token `active` em `auth_refresh_tokens`. A tabela de tokens mantém o histórico individual com estados `active`, `consumed` e `revoked`, validade, instante de consumo ou revogação e referência ao token substituto. O hash é único e nunca é carregado por eager loading.

No refresh, o registro exato do hash apresentado é bloqueado dentro de uma transação. Um token `active` válido passa a `consumed`, aponta para um novo token `active` e atualiza `last_used_at` da sessão. A reapresentação de um token `consumed` comprova reutilização: a sessão e todos os tokens ainda ativos da família são revogados, e o evento é auditado. Um hash que nunca existiu retorna o mesmo `401` genérico e registra apenas falha; ele não revoga a sessão indicada pelo `sessionId` público e não gera um falso evento de reutilização.

Sessões revogadas, expiradas ou pertencentes a usuário `inactive` não autenticam nem renovam tokens. Logout preserva a linha para auditoria. Uma rotina futura deverá remover sessões e logs antigos segundo uma política de retenção ainda não definida.

Eventos persistidos em `auth_audit_logs`:

- `auth.login.succeeded` e `auth.login.failed`;
- `auth.refresh.succeeded`, `auth.refresh.failed` e `auth.refresh.reuse_detected`;
- `auth.logout` e `auth.logout_all`.

Senha, tokens, segredos e hashes são removidos dos metadados de auditoria. Erros de login são genéricos para não revelar se o email existe.

### Endpoints

Todos usam o prefixo `/api/v1/auth`:

| Método | Caminho | Autenticação | Sucesso |
| --- | --- | --- | --- |
| `POST` | `/login` | pública | `200` |
| `POST` | `/refresh` | refresh token no body | `200` |
| `POST` | `/logout` | Bearer access token | `204` |
| `POST` | `/logout-all` | Bearer access token | `204` |
| `GET` | `/me` | Bearer access token | `200` |

Exemplo de login sem credencial real:

```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"<defina-localmente>"}'
```

Renovação:

```bash
curl -X POST http://localhost:3000/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<token-opaco>"}'
```

Consulta e revogação:

```bash
curl http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer <access-token>"
curl -X POST http://localhost:3000/api/v1/auth/logout \
  -H "Authorization: Bearer <access-token>"
curl -X POST http://localhost:3000/api/v1/auth/logout-all \
  -H "Authorization: Bearer <access-token>"
```

Payload inválido retorna `400`; credencial ou token inválido retorna `401`; excesso de tentativas retorna `429`. `403` não é usado para substituir falhas de autenticação e `503` permanece reservado à indisponibilidade real de dependências.

O limitador atual mantém contadores separados para cada combinação de IP e email normalizado e para o total agregado por IP. Buckets expirados são removidos periodicamente e o total em memória é limitado; ao atingir a capacidade, novas chaves são recusadas com `429` sem ampliar o uso de memória. Um login bem-sucedido limpa apenas o contador específico de IP e email, preservando a proteção agregada do IP. A implementação é adequada somente a uma instância: os contadores não são compartilhados entre réplicas e são perdidos ao reiniciar. Uma implantação com múltiplas instâncias deverá substituir a implementação pela mesma abstração usando armazenamento compartilhado.

Os tokens são retornados em JSON nesta etapa. O frontend poderá futuramente armazenar o refresh token em cookie `HttpOnly`, após decisão arquitetural conjunta. O backend não assume `localStorage` nem define agora a estratégia final de cookies.

## Testes com PostgreSQL isolado

Os testes de integração nunca aceitam um banco cujo nome não termine em `_test`. O arquivo `compose.test.yml` inicia PostgreSQL separado, descartável, na porta local 5433 e usa `tmpfs`.

```bash
npm run test:db:up
npm run test:integration
npm run test:db:down
```

Esse teste valida migrations em banco vazio, rollback, nova aplicação, enums, constraints, índices, foreign keys, credencial inicial, sessões, histórico de refresh tokens, auditoria, seed e idempotência. O e2e cobre login, me, refresh rotativo, reutilização comprovada, segredo aleatório sem revogação, expiração, logout, logout-all e bloqueios. Nunca aponte `TEST_DATABASE_*` para o banco de desenvolvimento.

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
    ├── auth/
    ├── auth-sessions/
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
- **Credenciais:** senhas usam Argon2id; refresh tokens usam HMAC-SHA-256 com pepper e rotação transacional.
- **Sessões persistidas:** access tokens só são aceitos quando usuário e sessão continuam ativos no PostgreSQL.
- **Escopo do token:** organização ativa e autorização por papel serão adicionadas somente em tarefas futuras.
- **Swagger adiado:** será mais útil quando existirem endpoints de negócio e seus DTOs.

## Problemas comuns

- **Falha de validação ao iniciar:** compare o `.env` com `.env.example` e confirme que não há valores vazios.
- **Banco desconectado fora do Docker:** use `DATABASE_HOST=localhost` e confirme porta, usuário e banco.
- **Banco desconectado no Docker:** use `DATABASE_HOST=postgres`; não use `localhost` dentro do container da API.
- **Porta ocupada:** altere `PORT` no `.env`.
- **Versão incompatível do Node:** execute `nvm use` ou instale Node 24.

## Próximos módulos previstos

Em tarefas futuras: escolha da organização ativa, autorização por tenant, convites e, posteriormente, módulos de CRM e integrações. Nenhuma dessas funcionalidades foi antecipada nesta etapa.
