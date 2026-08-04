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
Pipeline, Activities, Notes, Follow-up, filas, detalhe e métricas. O runtime
health e a baseline de produção do MVP também estão presentes na `main` desde o
PR #29, squash `5e76b4fde61badce3a39792f7ba9e3ee6ea806ce`.

O frontend oficial concluiu a Fase `0.7`: sessão e Organization ativa, cliente
HTTP, Inbox, detalhe, Pipeline, Follow-up, métricas e criação manual de Leads.
A última tarefa funcional foi `0.7.6`, incorporada pelo PR #7 no squash
`4e4f8db0fcd31a4280d72f8cba0a1e0b47f4fa92`.

O ciclo funcional existente é criar Lead → Inbox → detalhe → Pipeline →
Follow-up → métricas. Importação, formulário público conectado, comunicação,
WhatsApp, automações, calendário, estágios customizáveis e drag-and-drop
continuam indisponíveis e não são compromissos automáticos de produto.

## Fase atual e produção

A Fase `0.8-MVP` prepara a primeira produção para testes reais, sem antecipar a
infraestrutura definitiva. A baseline aceita usa Vercel + proxy same-origin
`/api/v1` + origem HTTPS protegida + Traefik + uma API NestJS + PostgreSQL 17
privado em uma VPS Hostinger KVM 2 dedicada (2 vCPU, 8 GB RAM e 100 GB NVMe).

O runtime health e a rebaseline documental foram concluídos pelo PR #29; a CI
pós-merge `30892867828` foi aprovada. A próxima etapa é a tarefa atual
`0.8-MVP-03 — Container e Compose de produção`, ainda sem implementação
iniciada ou aprovada. A VPS Hostinger KVM 2 já foi contratada e é o destino
previsto, mas seu inventário, configuração e adequação à topologia do MVP ainda
precisam ser comprovados. O estado de Vercel, DNS, origem, GHCR, banco, secrets,
backup, restore, monitoramento e deploy permanece pendente de inventário,
configuração ou validação para esta baseline. A infraestrutura real permanece
pendente e a aplicação não está pronta para dados reais.

Preview jamais acessará a API de produção. Consulte
[PRODUCTION.md](PRODUCTION.md) e o
[ADR-013](decisions/ADR-013-mvp-production-baseline.md) para a baseline e os
critérios de prontidão.

## Módulos futuros

Comunicação/WhatsApp, automações, tracking/analytics, relatórios e billing
continuam direções de produto sem escopo automaticamente aprovado.
