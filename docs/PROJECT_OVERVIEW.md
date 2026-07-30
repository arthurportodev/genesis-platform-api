# Visão geral do projeto

## Produto

A Genesis Platform é o SaaS multi-tenant da Agência Gênesis para centralizar a
operação comercial de organizações, usuários, Leads, ciclos, atividades,
Follow-up e métricas sem fragmentar identidade, contexto e autorização.

## Fronteiras do produto

- **Backend:** `arthurportodev/genesis-platform-api`, monólito modular NestJS e
  autoridade sobre API, regras de negócio, persistência, segurança tenant e o
  plano geral de produção.
- **Frontend:** `arthurportodev/genesis-platform-web`, SPA React/Vite oficial e
  autoridade sobre Vercel, proxy same-origin, Preview, cookies e publicação web.
- **Integrações:** comunicação e conectores externos continuam planejados, não
  implementados.
- **Exploração visual:** Lovable permanece opcional e não substitui o frontend
  oficial.

## Estado atual

O backend implementa identidade, multi-tenancy, autenticação, sessões,
convites, memberships/ownership e o CRM 0.3.1–0.3.4 com intake, Inbox,
Pipeline, Activities, Notes, Follow-up, filas, detalhe e métricas.

O frontend oficial concluiu a Fase `0.7`: sessão e Organization ativa, cliente
HTTP, Inbox, detalhe, Pipeline, Follow-up, métricas e criação manual de Leads.
A última tarefa funcional foi `0.7.6`, incorporada pelo PR #7 no squash
`4e4f8db0fcd31a4280d72f8cba0a1e0b47f4fa92`.

O ciclo funcional existente é criar Lead → Inbox → detalhe → Pipeline →
Follow-up → métricas. Importação, formulário público conectado, comunicação,
WhatsApp, automações, calendário, estágios customizáveis e drag-and-drop
continuam indisponíveis e não são compromissos automáticos de produto.

## Fase atual e produção

A Fase `0.8` prepara a primeira produção. Em 30 de julho de 2026 foi aceita a
arquitetura Vercel + proxy same-origin + origem protegida + Hetzner +
PostgreSQL. A decisão ainda não foi implementada: não existem projeto Vercel,
DNS, banco de produção, manifests aprovados, backup/restore comprovado,
observabilidade ou deploy. A aplicação não está pronta para dados reais.

Convites e email ficam desabilitados na primeira abertura. Staging não será
criado inicialmente, e Preview jamais acessará a API de produção. Consulte
[PRODUCTION.md](PRODUCTION.md) para o plano, o DAG e os critérios de prontidão.

## Módulos futuros

Comunicação/WhatsApp, automações, tracking/analytics, relatórios e billing
continuam direções de produto sem escopo automaticamente aprovado.
