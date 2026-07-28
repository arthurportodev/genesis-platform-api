# Visão geral do projeto

## Produto

A Genesis Platform é o SaaS multi-tenant da Agência Gênesis. Sua visão é centralizar a operação comercial de empresas em um produto único, reduzindo fragmentação entre ferramentas, dados e processos.

O público inicial são a própria Agência Gênesis e empresas atendidas por ela. Um usuário global poderá participar de várias organizações com vínculos e papéis diferentes.

## Problema

Operações comerciais costumam distribuir leads, atividades, comunicação, acompanhamento e relatórios entre planilhas e serviços sem contexto comum. A plataforma pretende concentrar esse ciclo com isolamento por organização e uma base preparada para integrações.

## Fronteiras do produto

- **Backend:** `arthurportodev/genesis-platform-api`, único backend oficial,
  implementado como monólito modular NestJS para API, regras de negócio,
  persistência, autenticação, isolamento multi-tenant e integrações.
- **Frontend:** `arthurportodev/genesis-platform-web`, aplicação oficial em
  repositório separado. Sua fundação é uma SPA React/Vite/TypeScript; a
  integração real com o backend permanece futura.
- **Integrações:** conectores externos e comunicação; planejados, não
  implementados.
- **Operação:** Vercel e Hetzner são destinos planejados para frontend e backend,
  respectivamente. Previews permanecem fail-closed, sem acesso à API até existir
  staging com origem estável, e nunca devem apontar para produção.
- **Exploração visual:** Lovable é somente referência ou ferramenta opcional de
  exploração; não substitui a implementação oficial.

## Estado atual

**Implementado:** fundação NestJS, PostgreSQL e Docker; usuário global,
organizações e memberships com papéis persistidos no vínculo; autenticação e
sessões; auditoria; seleção da organização ativa por request; tenant context
tipado com `userId`, `organizationId`, `membershipId` e `role`;
`AuthorizationModule`, `@Roles` e `RoleGuard` com listas explícitas; testes e
CI. O contrato web backend da 0.7.0 está incorporado. A fundação frontend
0.7.1.1 foi incorporada pelo PR #1 de `arthurportodev/genesis-platform-web`, com
SPA React/Vite/TypeScript, shell administrativo, rotas provisórias, design
system inicial, testes, CI e governança.

Requests tenant-scoped selecionam a organização por `X-Organization-Id`; o backend valida organization e membership ativas no PostgreSQL. Rotas consumidoras podem compor `AccessTokenGuard` → `TenantContextGuard` → `RoleGuard`; a autorização compara o papel persistido no `TenantContext` com listas explícitas, sem nova consulta ao banco.

**Ainda não implementado:** matriz geral de capacidades, permissions,
autorização por recurso, entidades comerciais tenant-scoped adicionais,
autenticação e sessão reais no frontend, access token em memória no runtime,
coordenação de refresh entre abas, cliente HTTP, Organization ativa, guards
reais, integração com a API, proxy same-origin, conexão com a Vercel, domínio,
deploy, integrações externas e módulos comerciais. Essas capacidades web
pertencem à futura Tarefa 0.7.1.2. Convites e gestão de memberships já são
consumidores tenant-scoped de produção.

O estágio atual valida identidade, persistência e acesso à organização ativa, mas ainda não é um CRM utilizável em produção.

## Módulos planejados

Os seguintes domínios representam direção de produto, não funcionalidade existente:

- CRM, leads, pipelines e atividades;
- comunicação e WhatsApp;
- automações;
- tracking e analytics;
- relatórios;
- gestão de usuários e membros;
- frontend operacional;
- billing, em horizonte futuro distante.

Consulte o [roadmap](ROADMAP.md) para a ordem atual e o [estado atual](CURRENT_STATE.md) para distinguir entrega de intenção.
