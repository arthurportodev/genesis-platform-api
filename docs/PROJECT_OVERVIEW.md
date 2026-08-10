# Visão geral do projeto

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

Fase, trabalho, operação, blockers, decisões e restrições atuais pertencem
somente a `docs/memory/project-state.v1.json`. Este documento preserva produto e
fronteiras duráveis; trechos datados abaixo são contexto histórico.

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

## Capacidades documentadas

O backend implementa identidade, multi-tenancy, autenticação, sessões,
convites, memberships/ownership e o CRM com intake, Inbox, Pipeline,
Activities, Notes, Follow-up, filas, detalhe e métricas.

O frontend oficial implementa sessão e Organization ativa, cliente HTTP,
Inbox, detalhe, Pipeline, Follow-up, métricas e criação manual de Leads.

O ciclo funcional existente é criar Lead → Inbox → detalhe → Pipeline →
Follow-up → métricas. Importação, formulário público conectado, comunicação,
WhatsApp, automações, calendário, estágios customizáveis e drag-and-drop
continuam indisponíveis e não são compromissos automáticos de produto.

## Contrato durável de produção

A topologia aprovada usa Vercel em `app.agenciagenesismkt.com.br` + proxy
same-origin `/api/v1` + API em `api.agenciagenesismkt.com.br` + Traefik + uma
API NestJS em container + PostgreSQL 17 privado na Hostinger KVM 2. O destino
de imagem é GHCR privado, o deploy inicial é manual, o backup externo usa
Google Drive, o monitoramento externo usa UptimeRobot sobre `/health` e o
ambiente inicial é somente produção, sem staging. Isso é arquitetura aprovada,
não prova de implementação ou estado live; esses fatos temporais pertencem
exclusivamente à memória canônica.

Preview jamais acessará a API de produção. Consulte
[PRODUCTION.md](PRODUCTION.md) e o
[ADR-013](decisions/ADR-013-mvp-production-baseline.md) para a baseline e os
critérios de prontidão.

## Módulos futuros

Comunicação/WhatsApp, automações, tracking/analytics, relatórios e billing
continuam direções de produto sem escopo automaticamente aprovado.
