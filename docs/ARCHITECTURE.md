# Arquitetura

## Estado atual

A API é um monólito modular NestJS executado em Node.js 24. PostgreSQL 17 é o banco relacional, TypeORM faz o mapeamento e migrations versionadas controlam o schema. Docker empacota a aplicação e o GitHub Actions valida cada Pull Request/push da `main`.

O bootstrap aplica o prefixo `/api/v1`, CORS para a origem configurada, validação com whitelist, serialização, filtro global de exceções, trust proxy por número de saltos e shutdown hooks.

```mermaid
flowchart LR
    Client["Cliente HTTP"] --> API["API NestJS /api/v1"]
    API --> Modules["Módulos da aplicação"]
    Modules --> ORM["TypeORM"]
    ORM --> DB["PostgreSQL 17"]
    CI["GitHub Actions"] --> Checks["Format, lint, build e testes"]
    Checks --> Image["Build Docker local"]
```

## Módulos existentes

- `ConfigurationModule`: carrega e valida ambiente com Joi.
- `DatabaseModule`: configura TypeORM sem sincronização ou migrations automáticas.
- `HealthModule`: expõe health check e verifica PostgreSQL com `SELECT 1`.
- `UsersModule`: registra a entidade global `User`.
- `OrganizationsModule`: registra `Organization`.
- `MembershipsModule`: registra o vínculo e o papel por organização.
- `AuthSessionsModule`: registra sessões, refresh tokens e auditoria.
- `AuthModule`: login, refresh, logout, usuário atual, tokens, guard, auditoria e rate limit.
- `TenantContextModule`: em implementação; valida organização e membership para requests tenant-scoped e fornece contexto tipado.

Os módulos de users, organizations e memberships ainda não têm controllers ou serviços de CRUD.

## Persistência e multi-tenancy

A estratégia aceita é shared database/shared schema. `User` é global; `Membership` liga um usuário a uma `Organization` e contém papel/status. Entidades de negócio tenant-scoped futuras deverão possuir `organization_id`.

```mermaid
erDiagram
    USER ||--o{ MEMBERSHIP : possui
    ORGANIZATION ||--o{ MEMBERSHIP : agrega
    USER ||--o{ AUTH_SESSION : autentica
    AUTH_SESSION ||--o{ AUTH_REFRESH_TOKEN : rotaciona
```

`synchronize` e `migrationsRun` permanecem desativados. As duas migrations atuais estão listadas no [estado atual](CURRENT_STATE.md). Consulte também o [ADR-002](decisions/ADR-002-multi-tenant-strategy.md).

## Autenticação implementada

1. `POST /auth/login` normaliza o email, aplica rate limit e verifica Argon2id.
2. Um login válido cria uma sessão e um refresh token persistidos em transação.
3. O access token JWT curto contém somente `sub`, `sessionId`, `type`, `iat` e `exp`.
4. O `AccessTokenGuard` valida assinatura/claims e consulta sessão e usuário no banco.
5. `POST /auth/refresh` bloqueia o registro apresentado, consome o token e cria o substituto.
6. Reutilização comprovada de token consumido revoga a família; um hash desconhecido não revoga sessão legítima.
7. Logout revoga a sessão atual; logout-all revoga as sessões ativas do usuário.

```mermaid
sequenceDiagram
    participant C as Cliente
    participant A as AuthModule
    participant D as PostgreSQL
    C->>A: Login com email e senha
    A->>D: Verifica usuário e cria sessão
    D-->>A: Sessão e refresh persistidos
    A-->>C: Access JWT e refresh opaco
    C->>A: Refresh opaco
    A->>D: Bloqueia, consome e rotaciona
    D-->>A: Novo token ativo
    A-->>C: Novo access e refresh
```

Mais detalhes estão no [ADR-003](decisions/ADR-003-authentication-sessions.md) e em [SECURITY.md](SECURITY.md).

### Fronteiras modulares dos guards

Quando um controller de outro módulo referencia um guard por classe com `@UseGuards(...)`, o NestJS precisa resolver as dependências desse guard no contexto do módulo consumidor. Para permitir essa composição natural sem tornar implementações internas públicas, os módulos exportam guards e portas opacas mínimas:

- O `AuthModule` exporta `AccessTokenGuard` e `ACCESS_TOKEN_AUTHENTICATOR`. O guard depende dessa porta, associada por `useExisting` à implementação privada `DatabaseAccessTokenAuthenticator`; `TokenService` e repositories permanecem privados.
- O `TenantContextModule` exporta `TenantContextGuard` e `TENANT_CONTEXT_RESOLVER`. O guard depende dessa porta, associada por `useExisting` à implementação privada `TenantContextService`; o service e repositories permanecem privados.

`useExisting` preserva uma única instância de cada implementação concreta. As portas expõem somente as capacidades necessárias aos guards, evitam factories, overrides ou manipulação de metadata nos módulos consumidores e não alteram as regras de autenticação ou tenant context.

## Contexto de tenant em implementação

Rotas tenant-scoped usarão `@UseGuards(AccessTokenGuard, TenantContextGuard)`. O primeiro guard autentica user e sessão; o segundo valida `X-Organization-Id`, consulta a membership e anexa `TenantContext` à request. O decorator `CurrentTenant` entrega esse contexto ao controller.

```mermaid
flowchart LR
    Request["Request com access token e X-Organization-Id"] --> Auth["AccessTokenGuard"]
    Auth --> Tenant["TenantContextGuard"]
    Tenant --> Membership["Membership ativa"]
    Membership --> Organization["Organization ativa"]
    Organization --> Context["TenantContext na request"]
```

- `userId`: vem exclusivamente do access token já validado.
- `organizationId`: vem exclusivamente do header UUID v4 validado.
- `membershipId` e `role`: vêm da membership persistida.
- Header ausente ou malformado resulta em `400`; autenticação ausente resulta em `401`; acesso não disponível resulta em `403` genérico.
- A validação não é global: rotas públicas e apenas autenticadas continuam sem exigir o header.
- Não há organização ou papel no JWT, autorização por papel, cache ou endpoint tenant-scoped de produção.

Consulte o [ADR-004](decisions/ADR-004-active-organization-context.md).

## Fronteiras

- **Implementado:** identidade, persistência multi-tenant básica, autenticação, sessões, auditoria e CI.
- **Em implementação:** seleção da organização ativa e contexto de tenant por request.
- **Planejado:** autorização por papel, membros e módulos comerciais.
- **Fora do estágio atual:** frontend, integrações, deploy e microservices.
