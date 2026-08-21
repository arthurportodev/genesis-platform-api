# Genesis Platform API

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

Fase, trabalho vigente, próxima tarefa, estado operacional, blockers e decisões
humanas são resolvidos somente na
[memória canônica](docs/memory/project-state.v1.json). O
[estado atual](docs/CURRENT_STATE.md) é uma projeção gerada e não deve ser
editado manualmente.

Backend da Genesis Platform, um SaaS de CRM e operação comercial multiempresa.
Esta versão contém a fundação técnica, núcleo persistente multi-tenant,
autenticação, contexto de organização ativa, autorização por papel, convites e
gestão de memberships/ownership.

A Tarefa 0.3.4 incorporou a experiência operacional do CRM no PR #21, squash
`f625745b17828a47208cc27461cc8cb6d8d9e67a`: busca, filtros, filas, Kanban,
detalhe consolidado e métricas.

A Tarefa 0.7.0 incorporou o contrato web de sessão no PR #22, squash
`9f0fb751f6e506ade1d0e0af0f7f80506b4a93f2`: refresh exclusivamente em cookie
protegido, CSRF cookie-to-header, logout idempotente e bootstrap autenticado de
Organizations.

O histórico de evolução funcional e operacional permanece em
`docs/TASK_LOG.md`; não use entradas históricas para inferir o estado vigente.

A gestão de memberships e ownership (0.2.5.4) concluiu a Fase 0.2 no PR #16,
squash `4392d7347035a216a273ce4395fd9e1bd83ab91b`, com CI pós-merge
29952145756 aprovada.

A activation recebe somente token, nome e senha, cria User, credencial e
Membership atomicamente e não realiza auto-login. Em produção, emissão e
substituição permanecem fail-closed até todas as precondições operacionais
estarem explícitas e a API pública operar com uma única réplica.

## Documentação do projeto

A memória oficial começa em [`docs/START_HERE.md`](docs/START_HERE.md). Consulte
também o [estado atual](docs/CURRENT_STATE.md), o [roadmap](docs/ROADMAP.md), a
[arquitetura](docs/ARCHITECTURE.md), a
[baseline operacional do MVP](docs/PRODUCTION.md), o
[runbook privado de onboarding de OWNER](docs/PRODUCTION_OWNER_ONBOARDING.md), o
[ADR-013](docs/decisions/ADR-013-mvp-production-baseline.md) e o
[índice de ADRs](docs/decisions/README.md).

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

| Variável                        | Finalidade                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`             | segredo aleatório com pelo menos 32 caracteres para assinar access tokens          |
| `JWT_ACCESS_EXPIRES_IN`         | duração curta no formato `15m`, `1h` etc.                                          |
| `REFRESH_TOKEN_EXPIRES_IN_DAYS` | validade absoluta da sessão/refresh token                                          |
| `REFRESH_TOKEN_PEPPER`          | segredo aleatório usado no HMAC do refresh token                                   |
| `INITIAL_OWNER_PASSWORD`        | senha local usada somente quando o seed ainda precisa criar a credencial inicial   |
| `AUTH_LOGIN_MAX_ATTEMPTS`       | falhas permitidas por combinação de IP e email                                     |
| `AUTH_LOGIN_IP_MAX_ATTEMPTS`    | falhas agregadas permitidas por IP, independentemente do email                     |
| `AUTH_LOGIN_MAX_BUCKETS`        | limite total de contadores mantidos em memória                                     |
| `AUTH_LOGIN_WINDOW_SECONDS`     | janela do limitador de login                                                       |
| `TRUST_PROXY_HOPS`              | quantidade de proxies reversos confiáveis entre o cliente e a API (`0` por padrão) |
| `FRONTEND_URL`                  | origem HTTP(S) exata permitida por CORS e validação de `Origin`, sem wildcard/path |

Limites das projeções operacionais do CRM:

| Variável                               | Finalidade                                                |
| -------------------------------------- | --------------------------------------------------------- |
| `LEAD_READ_RATE_LIMIT_WINDOW_SECONDS`  | janela dos limitadores de leitura                         |
| `LEAD_READ_MEMBERSHIP_MAX_ATTEMPTS`    | leituras permitidas por Membership na janela              |
| `LEAD_READ_IP_MAX_ATTEMPTS`            | leituras permitidas por IP confiável na janela            |
| `LEAD_METRICS_MEMBERSHIP_MAX_ATTEMPTS` | limite adicional de métricas por Membership na janela     |
| `LEAD_READ_RATE_LIMIT_MAX_BUCKETS`     | máximo de contadores de leitura mantidos no processo      |
| `LEAD_READ_STATEMENT_TIMEOUT_MS`       | timeout local de cada statement operacional no PostgreSQL |

Controle de acesso ao banco:

| Variável                                                  | Finalidade                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_USER` / `DATABASE_PASSWORD`                     | credenciais de login exclusivas da API runtime                                              |
| `DATABASE_RUNTIME_ROLE`                                   | role PostgreSQL LOGIN preexistente, idêntica a `DATABASE_USER`, sem `SUPERUSER`/`BYPASSRLS` |
| `DATABASE_MIGRATION_USER` / `DATABASE_MIGRATION_PASSWORD` | credenciais exclusivas do owner usado por migrations e seed                                 |

`DATABASE_RUNTIME_ROLE` deve ser distinta da role proprietária que executa
migrations. A migration não cria roles e falha fechada se a role configurada
não existir, coincidir com o owner da sessão ou possuir `SUPERUSER`/`BYPASSRLS`.
O startup da API falha se `DATABASE_USER` diferir de `DATABASE_RUNTIME_ROLE`.
Migrations usam somente `DATABASE_MIGRATION_USER`/`DATABASE_MIGRATION_PASSWORD`,
concedem o mínimo necessário por tabela e rejeitam qualquer privilégio efetivo
fora de `SELECT`/`INSERT` na auditoria organizacional, inclusive os recebidos por
herança. O
Compose provisiona a role runtime fora da migration, em banco vazio, e executa
as migrations em um job separado antes de iniciar a API.

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

O Compose constrói a API, inicia PostgreSQL 17 com volume persistente, provisiona
as roles distintas de owner/runtime, executa o job de migration e só então
inicia a API. Somente a porta da API é exposta. Para encerrar:

```bash
npm run docker:down
```

Para apagar também os dados locais do PostgreSQL, execute conscientemente `docker compose down -v`.

O Compose de produção é separado e não constrói imagens. Copie
`.env.production.example` para um arquivo local ignorado, preencha todos os
campos obrigatórios por canal seguro e use uma tag identificável construída do
target `production`:

```bash
docker build --target production -t genesis-platform-api:<candidate> .
docker compose --env-file .env.production.local -f compose.production.yml config
docker compose --env-file .env.production.local -f compose.production.yml up -d --wait
```

Essa stack contém somente PostgreSQL, migration e API. Ela não publica portas
da API ou do banco; o acesso futuro será pela rede de edge e pelo Traefik da
`0.8-MVP-06`. Não reutilize volumes de desenvolvimento ou validações anteriores.
Os limites de recursos são provisórios até o inventário da VPS na
`0.8-MVP-05`.

`TRUST_PROXY_HOPS=0` ignora `X-Forwarded-For` e é o padrão seguro quando a API é acessada diretamente. Em uma implantação com um único Traefik confiável na frente da API, use `TRUST_PROXY_HOPS=1` e bloqueie o acesso externo direto à porta da API; nunca configure confiança irrestrita em proxies.

## Health check

- `GET /health`: readiness pública para a infraestrutura.
- `GET /api/v1/health`: alias de compatibilidade da readiness.
- `GET /api/v1/health/live`: liveness independente do PostgreSQL.
- `GET /api/v1/health/ready`: readiness do runtime e do PostgreSQL.

Sucesso responde `200` com `{"status":"ok"}`. Indisponibilidade responde
`503` com `{"status":"unavailable"}`. Todas as respostas são mínimas,
sanitizadas e usam `Cache-Control: no-store`. O contrato completo está na
[arquitetura](docs/ARCHITECTURE.md).

## Qualidade e testes

```bash
npm run lint
npm run format:check
npm run build
npm run test
npm run test:e2e
npm run test:integration
npm run task:preflight
npm run db:test:env
npm run gate2:validate
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

Os comandos carregam as variáveis do `.env`; o CLI usa exclusivamente as
credenciais `DATABASE_MIGRATION_*`. `synchronize` permanece desabilitado: a
migration versionada é a única fonte de verdade do schema.

Antes de `migration:run`, um administrador deve criar a role indicada por
`DATABASE_RUNTIME_ROLE` como LOGIN sem `SUPERUSER` e sem `BYPASSRLS`. O comando
de migration usa uma role owner distinta; o rollback exige a mesma configuração
para remover os grants antes de excluir a tabela.

Os scripts de desenvolvimento recompilam quando as ferramentas necessárias
estão instaladas. A imagem de produção não contém o Nest CLI nem recompila no
startup; `compose.production.yml` chama diretamente o TypeORM compilado. No
Compose de desenvolvimento, os comandos continuam disponíveis:

```bash
docker compose run --rm migrate npm run migration:run
docker compose run --rm migrate npm run migration:show
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

## Contexto de organização ativa

Requests tenant-scoped usam `X-Organization-Id` após a autenticação. O backend valida no PostgreSQL, a cada request, que a organization e a membership do usuário estão ativas e anexa um contexto tipado com `userId`, `organizationId`, `membershipId` e `role`. O identificador da membership e o papel vêm exclusivamente do banco.

Autenticação e tenant context usam guards separados. JWT e sessão permanecem sem tenant ou papel. As rotas administrativas de convites são os primeiros consumidores tenant-scoped de produção.

Consulte o [estado atual](docs/CURRENT_STATE.md), a [arquitetura](docs/ARCHITECTURE.md), os [controles de segurança](docs/SECURITY.md) e o [ADR-004](docs/decisions/ADR-004-active-organization-context.md).

## Autorização por papel implementada

A Tarefa 0.2.4 implementou `AuthorizationModule`, `@Roles` e `RoleGuard`. Rotas tenant-scoped futuras poderão compor autenticação, tenant context e autorização, declarando listas explícitas de `owner`, `admin` e `member`. O guard usa somente o papel persistido já presente no `TenantContext`, sem nova consulta, cache ou papel vindo do cliente. Metadata do handler substitui a do controller, e configuração ausente, vazia ou malformada falha fechada.

Não há matriz geral de capacidades, hierarquia implícita, permissions ou
autorização por recurso. Gestão de membros e proteção do último owner são regras
explícitas da 0.2.5.4. Consulte o
[ADR-005](docs/decisions/ADR-005-role-based-authorization.md).

## Administração de convites

A Tarefa 0.2.5.1 registra cinco rotas tenant-scoped sob
`/api/v1/invitations`: criar, listar, consultar, revogar e
substituir. Todas exigem Bearer access token, `X-Organization-Id`, tenant ativo e
papel `owner` ou `admin`; admins enxergam e administram apenas convites de
`member`. Convites de `owner` não podem ser criados.

Criação e substituição consultam readiness operacional antes de transação,
idempotência, quota, auditoria ou outbox. A emissão em produção exige provider,
worker, acceptance, activation, keyring e frontend prontos, além de uma única
réplica pública enquanto rate limits e semaphore forem process-local.
Listagem, consulta e revogação continuam disponíveis para registros
persistidos.

O token assinado não aparece nas respostas administrativas e nunca é persistido
em forma bruta ou como hash. Consulte o
[ADR-007](docs/decisions/ADR-007-invitations-memberships-ownership.md).

Replace retorna publicamente somente `previousInvitationId`, `invitationId`,
`stateAtCreation` e `deliveryStatusAtCreation`. Replay devolve exatamente o
mesmo resultado; sua indicação adicional existe apenas no header
`Idempotency-Replayed`.

## Gestão de memberships e ownership

`/api/v1/members` oferece listagem/consulta e comandos explícitos para papel,
promoção a owner, desativação, reativação e saída própria. Owner administra
todos os demais membros; admin enxerga e administra somente `member`; nenhum
ator usa as rotas de target contra a própria membership.

Uma organização ativa mantém ao menos um owner efetivo: organization, User e
Membership precisam estar ativos e a Membership precisa ter papel `owner`.
Constraint triggers diferidos protegem SQL direto e a função privada tipada
serializa comandos concorrentes. Tentativas de remover o último owner retornam
`409` e persistem audit; no-op não cria audit. Consulte o
[runbook operacional](docs/MEMBERSHIP_OWNERSHIP_RUNBOOK.md).

Enquanto os limites de leitura forem process-local,
`API_PUBLIC_REPLICA_COUNT` deve ser `1`. O nome legado
`INVITATION_PUBLIC_REPLICA_COUNT` é aceito temporariamente; definir ambos com
valores diferentes impede a inicialização.

## Acceptance e activation de convites

`POST /api/v1/invitation-acceptance/inspect` inspeciona o bearer com resposta
mínima; `accept` exige login do usuário existente. A rota pública
`POST /api/v1/invitation-acceptance/activate` recebe exclusivamente `token`,
`name` e `password`, cria User, credencial e Membership atomicamente e responde
`201` somente com `organizationId` e `membershipId`. Ela não cria sessão nem
retorna access/refresh token; o login normal é usado depois.

Todos os endpoints usam `Cache-Control: no-store`. Activation indisponível por
estado, identidade, tenant, chave ou token válido estruturalmente converge para
`404 Invitation unavailable.`; overload retorna `429` e readiness retorna `503`.

## Seed inicial

O seed inicial é um mecanismo de desenvolvimento e bootstrap legado para a
identidade fixa descrita abaixo. Ele permanece documentado porque o contrato
técnico ainda é testado, mas não é o caminho normal para criar um OWNER em
produção. Para uma criação produtiva autorizada, use exclusivamente o
[CLI privado de onboarding](docs/PRODUCTION_OWNER_ONBOARDING.md).

Após aplicar as migrations, execute manualmente. Na primeira execução, forneça a senha somente ao processo do seed, sem gravá-la no `.env` nem mantê-la no ambiente permanente da API:

```bash
docker compose run --rm -e INITIAL_OWNER_PASSWORD="<defina-localmente>" migrate npm run seed
```

O seed cria, dentro de uma transação:

- organização `Agência Gênesis`, slug `agencia-genesis`;
- usuário `Arthur Porto`, email `contato@agenciagenesismkt.com.br`;
- membership com papel `owner` e status `active`.

O seed não executa durante a inicialização da API e é idempotente. Uma segunda execução localiza os três registros existentes e não cria duplicações.

Se o usuário inicial ainda não possuir credencial, o seed também exige `INITIAL_OWNER_PASSWORD`, gera um hash Argon2id e registra apenas que a credencial foi criada. Se o hash já existir, ele não é substituído automaticamente e a variável deixa de ser obrigatória para essa execução.

Não use o seed como procedimento normal de onboarding em produção e nunca o
execute com senha padrão. Seu uso excepcional exige escopo e autorização
operacional próprios.

Quando a credencial inicial já existir, novas execuções idempotentes não exigem a variável e não substituem o hash existente:

```bash
docker compose run --rm migrate npm run seed
```

## Autenticação e sessões

A autenticação usa email e senha, Argon2id e dois tipos de token:

- **Access token:** JWT HS256 curto e configurável. O payload contém somente `sub`, `sessionId`, `type: access`, `iat` e `exp`.
- **Refresh token:** valor opaco e imprevisível no formato `sessionId.secret`, entregue exclusivamente em cookie `HttpOnly`; o PostgreSQL armazena somente HMAC-SHA-256 com `REFRESH_TOKEN_PEPPER`.

O hash de senha e o hash de refresh token não são selecionados pelo TypeORM por padrão e nunca fazem parte das respostas. O access token não contém organização, membership, papel ou permissão.

Cada login cria uma linha em `auth_sessions` e um token `active` em `auth_refresh_tokens`. A tabela de tokens mantém o histórico individual com estados `active`, `consumed` e `revoked`, validade, instante de consumo ou revogação e referência ao token substituto. O hash é único e nunca é carregado por eager loading.

No refresh, uma pré-leitura mínima encontra os IDs pelo par exato sessão/hash,
sem decidir autorização. Na mesma transação, o serviço bloqueia `User`,
`AuthSession` e `AuthRefreshToken` nessa ordem, relê o estado completo e somente
então valida e rotaciona. O lock do user passa pela função interna estreita
`app_private.lock_auth_refresh_user(uuid)` com `FOR NO KEY UPDATE`; assim a role
runtime mantém `users` sem `UPDATE`, inativação/delete/mudança de chave continuam
serializados e inserts de auditoria com foreign key podem obter `KEY SHARE`. Um
token `active` válido passa a `consumed`, aponta para um novo token `active` e
atualiza `last_used_at` da sessão. A reapresentação de um token `consumed`
comprova reutilização: a sessão e todos os tokens ainda ativos da família são
revogados, e o evento é auditado. Um hash que nunca existiu retorna o mesmo
`401` genérico e registra apenas falha; ele não revoga a sessão indicada pelo
`sessionId` público e não gera um falso evento de reutilização.

Sessões revogadas, expiradas ou pertencentes a usuário `inactive` não autenticam nem renovam tokens. Logout preserva a linha para auditoria, não exige access token, limpa os cookies e responde `204` mesmo quando não identifica sessão. Uma rotina futura deverá remover sessões e logs antigos segundo uma política de retenção ainda não definida.

Em produção, refresh usa `__Host-genesis_refresh` (`HttpOnly`, `Secure`,
`SameSite=Lax`, `Path=/`, sem `Domain`) e CSRF usa
`__Host-genesis_csrf` com os mesmos atributos, exceto `HttpOnly=false`.
Desenvolvimento e teste usam nomes separados e `Secure=false`. Login, refresh,
logout e logout-all exigem cookie CSRF + `X-CSRF-Token`; uma origem presente
deve coincidir exatamente com `FRONTEND_URL`. Access token permanece no JSON e
fica somente em memória no frontend implementado; nenhum token deve ir para
`localStorage`.

Eventos persistidos em `auth_audit_logs`:

- `auth.login.succeeded` e `auth.login.failed`;
- `auth.refresh.succeeded`, `auth.refresh.failed` e `auth.refresh.reuse_detected`;
- `auth.logout` e `auth.logout_all`.

Senha, tokens, segredos e hashes são removidos dos metadados de auditoria. Erros de login são genéricos para não revelar se o email existe.

### Endpoints

Todos usam o prefixo `/api/v1/auth`:

| Método | Caminho       | Autenticação/defesa             | Sucesso |
| ------ | ------------- | ------------------------------- | ------- |
| `GET`  | `/csrf`       | pública                         | `200`   |
| `POST` | `/login`      | cookie CSRF + `X-CSRF-Token`    | `200`   |
| `POST` | `/refresh`    | refresh cookie + CSRF           | `200`   |
| `POST` | `/logout`     | refresh cookie opcional + CSRF  | `204`   |
| `POST` | `/logout-all` | Bearer access token + CSRF      | `204`   |
| `GET`  | `/me`         | Bearer access token             | `200`   |
| `GET`  | `/bootstrap`  | Bearer access token, sem tenant | `200`   |

Exemplo de sessão web sem credencial real (`curl` usa o cookie jar):

```bash
CSRF=$(curl -s -c cookies.txt http://localhost:3000/api/v1/auth/csrf | jq -r .csrfToken)
curl -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF" \
  -d '{"email":"user@example.com","password":"<defina-localmente>"}'
```

Renovação:

```bash
curl -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/v1/auth/refresh \
  -H "X-CSRF-Token: $CSRF"
```

Consulta e revogação (os dois comandos de logout são alternativas para uma
mesma sessão):

```bash
curl http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer <access-token>"
curl http://localhost:3000/api/v1/auth/bootstrap \
  -H "Authorization: Bearer <access-token>"
curl -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/v1/auth/logout \
  -H "X-CSRF-Token: $CSRF"
curl -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/v1/auth/logout-all \
  -H "X-CSRF-Token: $CSRF" \
  -H "Authorization: Bearer <access-token>"
```

Payload inválido retorna `400`; credencial ou token inválido retorna `401`;
CSRF/origem inválidos retornam `403` genérico; excesso de tentativas retorna
`429`. `503` permanece reservado à indisponibilidade real de dependências.

O limitador atual mantém contadores separados para cada combinação de IP e email normalizado e para o total agregado por IP. Buckets expirados são removidos periodicamente e o total em memória é limitado; ao atingir a capacidade, novas chaves são recusadas com `429` sem ampliar o uso de memória. Um login bem-sucedido limpa apenas o contador específico de IP e email, preservando a proteção agregada do IP. A implementação é adequada somente a uma instância: os contadores não são compartilhados entre réplicas e são perdidos ao reiniciar. Uma implantação com múltiplas instâncias deverá substituir a implementação pela mesma abstração usando armazenamento compartilhado.

Somente o access token curto é retornado em JSON e deve permanecer em memória
no frontend. O refresh token trafega exclusivamente no cookie `HttpOnly`
definido pelo backend; nenhum dos dois deve ser armazenado em `localStorage`.

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
    ├── authorization/
    ├── leads/
    ├── memberships/
    ├── organizations/
    ├── tenant-context/
    └── users/
```

Os módulos de users e organizations não expõem CRUD. Invitations, memberships e Leads consomem a fronteira tenant-scoped.

## Decisões técnicas

- **Monólito modular:** mantém o início simples e permite separar responsabilidades conforme o produto crescer.
- **TypeORM:** integração nativa com NestJS, driver PostgreSQL maduro e suporte direto a migrations versionadas.
- **Schema sem sincronização automática:** `synchronize` permanece desabilitado em todos os ambientes; migrations serão a fonte de verdade.
- **Configuração centralizada:** `@nestjs/config` e Joi validam o ambiente; os consumidores usam `ConfigService`.
- **Runtime health separado:** liveness não consulta PostgreSQL; readiness
  executa `SELECT 1` para validar a dependência do banco.
- **UUID no PostgreSQL:** `gen_random_uuid()` mantém a geração consistente inclusive em inserts fora do TypeORM. A migration habilita `pgcrypto` quando necessário e o rollback não remove a extensão, pois ela pode ser compartilhada.
- **Exclusão conservadora:** FKs `RESTRICT` impedem que exclusões de user/organization removam silenciosamente memberships ou entidades do outro lado.
- **Credenciais:** senhas usam Argon2id; refresh tokens usam HMAC-SHA-256 com pepper e rotação transacional.
- **Sessões persistidas:** access tokens só são aceitos quando usuário e sessão continuam ativos no PostgreSQL.
- **Escopo do token:** JWT e sessão permanecem sem tenant ou papel; a organização ativa e o papel atual são validados no PostgreSQL por request.
- **Autorização explícita:** a infraestrutura implementada aceita somente papéis listados por rota, sem hierarquia ou permissions.
- **Swagger adiado:** será mais útil quando existirem endpoints de negócio e seus DTOs.

## Problemas comuns

- **Falha de validação ao iniciar:** compare o `.env` com `.env.example` e confirme que não há valores vazios.
- **Banco desconectado fora do Docker:** use `DATABASE_HOST=localhost` e confirme porta, usuário e banco.
- **Banco desconectado no Docker:** use `DATABASE_HOST=postgres`; não use `localhost` dentro do container da API.
- **Porta ocupada:** altere `PORT` no `.env`.
- **Versão incompatível do Node:** execute `nvm use` ou instale Node 24.

## Continuidade

Consulte a [memória canônica](docs/memory/project-state.v1.json) para descobrir
o próximo trabalho. Este README preserva somente contratos duráveis de uso e
desenvolvimento.
