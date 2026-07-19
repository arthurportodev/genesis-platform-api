# Visão geral do projeto

## Produto

A Genesis Platform é o SaaS multi-tenant da Agência Gênesis. Sua visão é centralizar a operação comercial de empresas em um produto único, reduzindo fragmentação entre ferramentas, dados e processos.

O público inicial são a própria Agência Gênesis e empresas atendidas por ela. Um usuário global poderá participar de várias organizações com vínculos e papéis diferentes.

## Problema

Operações comerciais costumam distribuir leads, atividades, comunicação, acompanhamento e relatórios entre planilhas e serviços sem contexto comum. A plataforma pretende concentrar esse ciclo com isolamento por organização e uma base preparada para integrações.

## Fronteiras do produto

- **Backend:** API, regras de negócio, persistência, autenticação, isolamento multi-tenant e integrações.
- **Frontend:** interface operacional; ainda não iniciado e futuramente conduzido na fase própria.
- **Integrações:** conectores externos e comunicação; planejados, não implementados.

## Estado atual

**Implementado:** fundação NestJS, PostgreSQL e Docker; usuário global, organizações e memberships com papéis persistidos no vínculo; autenticação e sessões; auditoria; seleção da organização ativa por request; tenant context tipado com `userId`, `organizationId`, `membershipId` e `role`; testes e CI.

Requests tenant-scoped selecionam a organização por `X-Organization-Id`; o backend valida organization e membership ativas no PostgreSQL. A branch da tarefa 0.2.4 adiciona, ainda em revisão, autorização genérica por listas explícitas de papéis sobre o `TenantContext`, sem nova consulta ao banco.

**Ainda não implementado:** matriz real de capacidades, permissions, proteção do último owner, convites, gestão de membros, entidades comerciais tenant-scoped, frontend, deploy, integrações externas e módulos comerciais. Também não existe endpoint tenant-scoped de produção; a infraestrutura de autorização da branch ainda não foi revisada ou mesclada.

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
