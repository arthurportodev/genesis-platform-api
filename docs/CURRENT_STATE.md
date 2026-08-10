<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v1.json -->

# Estado atual

Esta projeção é gerada deterministicamente. Não edite manualmente; a autoridade temporal única é [docs/memory/project-state.v1.json](memory/project-state.v1.json).

- **Revisão de estado:** GH-01-COMPLETE
- **Atualização documentada:** 2026-08-10T19:42:11Z
- **Fase:** 0.8-MVP — Primeira produção mínima viável
- **Último trabalho concluído:** 0.8-MVP-05B — Baseline privada na VPS
- **Trabalho vigente:** none — Nenhuma tarefa posterior é iniciada por esta autoridade.
- **Próxima tarefa:** 0.8-MVP-06 — Traefik, HTTPS e exposição controlada da API
- **Web integrado:** fa4193fc28751d64923be824d293367499d4fba0
- **Proveniência da API:** containing-commit

## Estado operacional

A evidência aprovada documenta uma baseline privada e destinos arquiteturais aprovados; o estado live não foi observado nesta tarefa.

- **OPS-PRIVATE-BASELINE** [documented/present] — API e PostgreSQL são documentados como instalados em uma baseline privada.
- **OPS-PUBLIC-HTTPS** [documented/absent] — Traefik, HTTPS, DNS e exposição pública controlada não estão documentados como implementados.
- **OPS-APPROVED-EDGE** [documented/present] — A arquitetura aprovada define frontend na Vercel em app.agenciagenesismkt.com.br, API em api.agenciagenesismkt.com.br e Traefik como proxy HTTPS; implementação e estado live não estão comprovados.
- **OPS-APPROVED-RUNTIME** [documented/present] — A arquitetura aprovada define Hostinger KVM 2, API NestJS em container, PostgreSQL em rede privada e somente produção inicialmente, sem staging; estado live não está comprovado.
- **OPS-APPROVED-DELIVERY** [documented/present] — O destino aprovado usa GHCR privado e deploy inicial manual com aprovação humana; o contrato implementado e a visibilidade live do package exigem verificação separada.
- **OPS-APPROVED-RECOVERY** [documented/present] — Google Drive é o destino externo de backup aprovado; RPO, RTO, retenção, implementação e restore comprovado permanecem separados desta decisão.
- **OPS-APPROVED-MONITORING** [documented/present] — UptimeRobot sobre /health é o monitoramento externo aprovado; alertas, destinatários, escalonamento, implementação e estado live permanecem separados desta decisão.
- **OPS-GHCR-VISIBILITY** [unknown/unknown] — Há histórico documentado de package GHCR público, mas a visibilidade live atual não foi observada nesta tarefa.
- **OPS-LIVE-STATE** [unknown/unknown] — VPS, containers, banco, firewall e serviços externos não foram observados nesta tarefa.
- **OPS-REAL-DATA** [documented/not-authorized] — Dados reais não estão autorizados.

## Blockers abertos

- **BLOCK-PUBLIC-ORIGIN** — Abertura exige implementar e comprovar Traefik, TLS, DNS dos hostnames aprovados e exposição controlada.
- **BLOCK-RECOVERY** — Google Drive foi aprovado como destino; RPO, RTO, retenção e restore sintético precisam ser aprovados ou comprovados antes de dados reais.

## Decisões humanas pendentes

- **HD-BACKUP** — Quais RPO, RTO e retenção serão aprovados para o backup externo no Google Drive?
- **HD-MONITORING** — Qual política de alertas, destinatários e escalonamento será aprovada para o UptimeRobot e os sinais internos?
- **HD-REAL-DATA** — Quais primeiros usuários e dados reais poderão ser autorizados, e em qual momento?

## Release gates

- **RG-TLS** [pending] — Traefik, HTTPS e hostnames aprovados devem ser comprovados antes da abertura.
- **RG-RECOVERY** [pending] — Backup recuperável e restore sintético devem passar antes de dados reais.
- **RG-CROSS-TENANT** [pending] — Smoke funcional e teste adversarial cross-tenant devem passar antes dos primeiros usuários.

## Restrições atuais

- **OR-SINGLE-VPS** — A baseline documentada usa uma única VPS e um único failure domain.
- **OR-SINGLE-REPLICA** — A API pública permanece limitada a uma réplica enquanto controles forem process-local.
- **OR-NO-REAL-DATA** — Dados reais permanecem não autorizados.
