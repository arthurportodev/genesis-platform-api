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

**Implementado:** fundação NestJS, PostgreSQL e Docker; modelo de usuários, organizações e memberships; autenticação e sessões persistidas; auditoria; testes; CI.

**Ainda não implementado:** organização ativa, contexto de tenant, autorização por papel, gestão de membros e módulos comerciais.

O estágio atual valida identidade e persistência. Não é ainda um CRM utilizável em produção e não possui frontend, deploy ou integrações externas.

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
