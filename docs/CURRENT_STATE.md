<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v1.json -->

# Estado atual

Esta projeção é gerada deterministicamente. Não edite manualmente; a autoridade temporal única é [docs/memory/project-state.v1.json](memory/project-state.v1.json).

- **Revisão de estado:** GH-01-COMPLETE
- **Atualização documentada:** 2026-08-11T17:13:48Z
- **Fase:** 0.8-MVP — Primeira produção mínima viável
- **Último trabalho concluído:** 0.8-MVP-06A — Traefik health-only edge — contrato incorporado
- **Trabalho vigente:** planned — O Gate 1 operacional da 0.8-MVP-06B está pronto com condições. Nenhuma mutação live foi iniciada.
- **Próxima tarefa:** 0.8-MVP-06B-CONDITIONS — Decisões operacionais e autorização de preoperação
- **Web integrado:** fa4193fc28751d64923be824d293367499d4fba0
- **Proveniência da API:** containing-commit

## Estado operacional

O Gate 1 observou a baseline privada saudável e pronta com condições, enquanto Traefik live, ACME, certificado, HTTPS público, bindings 80/443 e deployment 06B permanecem ausentes. Nenhuma operação foi autorizada ou iniciada.

- **OPS-PRIVATE-BASELINE** [documented/present] — API e PostgreSQL são documentados como instalados em uma baseline privada.
- **OPS-PRIVATE-BASELINE-LIVE** [observed/present] — API e PostgreSQL foram observados running e healthy, sem bindings de porta no host; a rede do banco permanece privada.
- **OPS-PUBLIC-SSH-ONLY** [observed/present] — Somente TCP/22 estava publicamente alcançável; TCP/80 e TCP/443 expiraram no snapshot aprovado.
- **OPS-06A-CONTRACTS** [observed/present] — Os contratos 06A de edge Traefik health-only foram incorporados à API main por PR #41; o CI pós-merge passou sem publicação nem deploy.
- **OPS-APPROVED-EDGE** [documented/present] — A arquitetura aprovada define frontend na Vercel em app.agenciagenesismkt.com.br, API em api.agenciagenesismkt.com.br e Traefik como proxy HTTPS; implementação e estado live são registrados separadamente.
- **OPS-APPROVED-RUNTIME** [documented/present] — A arquitetura aprovada define Hostinger KVM 2, API NestJS em container, PostgreSQL em rede privada e somente produção inicialmente, sem staging.
- **OPS-APPROVED-DELIVERY** [documented/present] — O destino aprovado usa GHCR privado e deploy inicial manual com aprovação humana; a visibilidade live observada é registrada separadamente.
- **OPS-COMMITTED-RELEASE-BUNDLE** [observed/present] — O bundle committed-release foi derivado localmente do squash 06A e validado; não foi transferido para a VPS.
- **OPS-API-IMAGE-PRESERVED** [observed/present] — A imagem API atual foi preservada pelo digest aprovado; nenhuma publicação ocorreu no CI pós-merge.
- **OPS-TRAEFIK-IMAGE-APPROVED** [observed/present] — A imagem Traefik para linux/amd64 foi resolvida e aprovada por digest imutável; não foi instalada na VPS.
- **OPS-VPS-READINESS** [observed/present] — Capacidade, NTP, Docker, UFW, Fail2ban, AppArmor e serviços essenciais da VPS foram observados saudáveis.
- **OPS-TRAEFIK-LIVE** [observed/absent] — Nenhum container Traefik estava ativo ou instalado na VPS.
- **OPS-ACME-STATE** [observed/absent] — O diretório de estado Traefik e os arquivos ACME staging e production estavam ausentes.
- **OPS-PUBLIC-CERTIFICATE** [observed/absent] — Nenhum certificado público da API foi observável no Gate 1.
- **OPS-PUBLIC-HTTPS** [observed/absent] — Nenhum endpoint HTTPS público da API estava disponível.
- **OPS-PUBLIC-HTTP-BINDINGS** [observed/absent] — Não havia listeners ou bindings públicos TCP/80 e TCP/443 no host.
- **OPS-06B-DEPLOYMENT** [observed/absent] — Nenhuma implantação 06B, publicação ou mutação de produção foi executada.
- **OPS-DNS-API** [observed/absent] — api.agenciagenesismkt.com.br retornou NXDOMAIN de forma consistente no snapshot do Gate 1.
- **OPS-DNS-APP** [observed/present] — app.agenciagenesismkt.com.br apresentou A 185.158.133.1, sem CNAME ou AAAA, no snapshot do Gate 1.
- **OPS-VERCEL-LINK** [observed/unknown] — O vínculo de app.agenciagenesismkt.com.br com a Vercel não foi comprovado; a Vercel não foi inspecionada por ausência de sessão read-only autorizada.
- **OPS-ACME-CONTACT** [documented/present] — Arthur aprovou contato@agenciagenesismkt.com.br como email de registro ACME para staging e production. A decisão não configura ACME nem autoriza emissão de certificado.
- **OPS-APPROVED-RECOVERY** [documented/present] — Google Drive permanece o destino externo de backup aprovado; RPO, RTO, retenção, implementação e restore comprovado seguem pendentes.
- **OPS-APPROVED-MONITORING** [documented/present] — UptimeRobot sobre /health permanece o destino de monitoramento externo aprovado; política de alertas e implementação seguem pendentes.
- **OPS-GHCR-VISIBILITY** [unknown/unknown] — Há histórico documentado de package GHCR público; este fato preserva a separação entre o destino privado aprovado e observações live.
- **OPS-GHCR-PUBLIC-READ-OBSERVED** [observed/present] — O package GHCR da API aceitou leitura anônima no Gate 1; a transição futura para privado permanece separada.
- **OPS-REAL-DATA** [documented/not-authorized] — Dados reais não estão autorizados.

## Blockers abertos

- **BLOCK-PUBLIC-ORIGIN** — O contrato 06A está incorporado; implantação live, DNS, TLS e exposição health-only continuam pendentes e exigem autorizações próprias.
- **BLOCK-WEB-VERCEL-FUNCTIONAL** — O vínculo app./Vercel precisa ser reconciliado antes da futura exposição funcional /api/v1; não bloqueia o edge health-only da 06B.
- **BLOCK-RECOVERY** — Google Drive foi aprovado como destino; RPO, RTO, retenção e restore sintético precisam ser aprovados ou comprovados antes de dados reais.

## Decisões humanas pendentes

- **HD-DNS-OPERATOR-AUTHORITY** — Quem operará o DNS e qual autoridade DNS será usada na preoperação?
- **HD-DNS-TTL** — Qual TTL será aprovado para os registros DNS da operação?
- **HD-CHANGE-WINDOW** — Qual janela de mudança será aprovada para a preoperação e a exposição controlada?
- **HD-DOWNTIME-TOLERANCE** — Qual tolerância de indisponibilidade será aceita durante a janela?
- **HD-SNAPSHOT-OR-WAIVER** — Será exigido snapshot prévio ou haverá dispensa humana explícita?
- **HD-AUTHORIZE-PRIVATE-INSTALL** — A instalação privada do Traefik será autorizada na janela aprovada?
- **HD-AUTHORIZE-TRUST-PROXY-PROBE** — O probe sintético de trust proxy será autorizado?
- **HD-AUTHORIZE-DNS-TCP80-ACME-STAGING** — DNS, TCP/80 e ACME staging serão autorizados em conjunto no checkpoint correspondente?
- **HD-AUTHORIZE-ACME-PRODUCTION** — A emissão ACME production será autorizada após o staging aprovado?
- **HD-AUTHORIZE-TCP443-PUBLIC-FULL** — TCP/443 e o override public-full serão autorizados após certificado válido?
- **HD-OBSERVATION-DURATION** — Qual duração de observação será exigida após cada transição?
- **HD-KEEP-OR-REVERT** — Quais critérios e quem decidirá keep ou revert ao fim da observação?
- **HD-ROLLBACK-OWNER-AUTHORIZATION** — Quem será o owner do rollback e qual autorização poderá acioná-lo?
- **HD-WEB-VERCEL-RECONCILIATION** — Como app.agenciagenesismkt.com.br e a Vercel serão reconciliados antes do proxy funcional /api/v1?
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
- **OR-POSTGRES-PRIVATE** — O PostgreSQL deve permanecer privado, sem binding de porta no host ou exposição direta à Internet.
- **OR-FUNCTIONAL-API-FAIL-CLOSED** — A API funcional /api/v1 permanece fail-closed; a 06B limita a exposição pública ao health-only.
