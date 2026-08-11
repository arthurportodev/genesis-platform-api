<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v1.json -->

# Estado atual

Esta projeção é gerada deterministicamente. Não edite manualmente; a autoridade temporal única é [docs/memory/project-state.v1.json](memory/project-state.v1.json).

- **Revisão de estado:** GH-01-COMPLETE
- **Atualização documentada:** 2026-08-11T20:56:37.6832323Z
- **Fase:** 0.8-MVP — Primeira produção mínima viável
- **Último trabalho concluído:** 0.8-MVP-06B-WINDOW-1 — Private edge ativo — exposição pública fechada
- **Trabalho vigente:** in-progress — A Window 1 da 0.8-MVP-06B foi concluída com KEEP e edge privado ativo; a exposição pública permanece fechada e a Window 2 ainda depende de preflight e autorizações próprias.
- **Próxima tarefa:** 0.8-MVP-06B-WINDOW-2-PREFLIGHT — Preparar preflight e decisões humanas da Window 2, sem iniciar a operação
- **Web integrado:** fa4193fc28751d64923be824d293367499d4fba0
- **Proveniência da API:** containing-commit

## Estado operacional

A Window 1 foi concluída com KEEP: release 06A promovido, Traefik ativo somente em loopback e TRUST_PROXY_HOPS=1, enquanto API e PostgreSQL permanecem privados. DNS, TCP/80 e TCP/443 públicos, ACME, certificado, publicação, deploy público e rotas funcionais públicas permanecem ausentes ou não autorizados.

- **OPS-PRIVATE-BASELINE** [documented/present] — API e PostgreSQL são documentados como instalados em uma baseline privada.
- **OPS-PRIVATE-BASELINE-LIVE** [observed/present] — API e PostgreSQL permaneceram running e healthy após a Window 1, com zero reinícios inesperados e sem bindings de porta no host; a rede do banco permanece privada.
- **OPS-PUBLIC-SSH-ONLY** [observed/present] — A superfície pública permaneceu restrita a TCP/22; os testes externos finais não conectaram em TCP/80 nem TCP/443.
- **OPS-06A-CONTRACTS** [observed/present] — Os contratos 06A de edge Traefik health-only foram incorporados à API main por PR #41; o CI pós-merge passou sem publicação nem deploy.
- **OPS-APPROVED-EDGE** [documented/present] — A arquitetura aprovada define frontend na Vercel em app.agenciagenesismkt.com.br, API em api.agenciagenesismkt.com.br e Traefik como proxy HTTPS; implementação e estado live são registrados separadamente.
- **OPS-APPROVED-RUNTIME** [documented/present] — A arquitetura aprovada define Hostinger KVM 2, API NestJS em container, PostgreSQL em rede privada e somente produção inicialmente, sem staging.
- **OPS-APPROVED-DELIVERY** [documented/present] — O destino aprovado usa GHCR privado e deploy inicial manual com aprovação humana; a visibilidade live observada é registrada separadamente.
- **OPS-COMMITTED-RELEASE-BUNDLE** [observed/present] — O bundle committed-release validado do squash 06A foi transferido, revalidado na VPS e promovido atomicamente como release ativo da Window 1; o release anterior foi preservado.
- **OPS-API-IMAGE-PRESERVED** [observed/present] — A API usa o digest aprovado, está saudável com TRUST_PROXY_HOPS=1 e sem binding no host; somente a API foi recriada no Checkpoint C, com downtime medido de 4,711 segundos.
- **OPS-TRAEFIK-IMAGE-APPROVED** [observed/present] — A imagem Traefik aprovada por digest imutável para linux/amd64 está ativa em modo internal, sem Docker socket, dashboard ou ACME habilitado.
- **OPS-VPS-READINESS** [observed/present] — A observação da Window 1 registrou CPU máxima de 27,82%, memória máxima de 8,14%, disco em 5% e serviços essenciais saudáveis, sem disparar critério de rollback.
- **OPS-TRAEFIK-LIVE** [observed/present] — O Traefik está running em modo internal, com zero reinícios e bindings exclusivos em 127.0.0.1:18080 e 127.0.0.1:18443; a matriz health-only passou e nenhuma rota funcional ficou pública.
- **OPS-ACME-STATE** [observed/present] — Os arquivos ACME staging e production existem vazios, root:root e modo 0600; nenhum conteúdo foi lido ou hasheado, nenhuma requisição ACME ocorreu e nenhum certificado foi emitido.
- **OPS-PUBLIC-CERTIFICATE** [documented/absent] — Nenhum certificado público da API foi solicitado ou emitido na Window 1.
- **OPS-PUBLIC-HTTPS** [observed/absent] — Nenhum endpoint HTTPS público da API foi habilitado; TCP/443 público permaneceu fechado.
- **OPS-PUBLIC-HTTP-BINDINGS** [observed/absent] — Não há listeners ou bindings públicos TCP/80 e TCP/443; somente os listeners privados de loopback do Traefik foram mantidos.
- **OPS-06B-DEPLOYMENT** [observed/partial] — A Window 1 executou somente a mutação privada aprovada e recebeu KEEP; a 06B integral não foi concluída, e não houve publicação, deploy público ou exposição funcional.
- **OPS-06B-WINDOW1-OBSERVATION** [observed/present] — A observação privada concluiu 61 amostras em 3.603 segundos, sem falha de health ou readiness, reinício inesperado, exposição pública, alteração de estado ACME ou critério de rollback.
- **OPS-06B-WINDOW1-PROBE** [observed/present] — O probe sintético privado autorizado comprovou rate limiting, auditoria sanitizada e rejeição do forwarded header forjado, sem usuário ou dado real e sem editar ou apagar registros.
- **OPS-06B-WINDOW1-KEEP** [observed/present] — Arthur Porto decidiu explicitamente KEEP após a observação, mantendo o edge privado e TRUST_PROXY_HOPS=1; a decisão não autorizou a Window 2 nem qualquer exposição pública.
- **OPS-06B-ROLLBACK-READY** [observed/present] — O release anterior e o retorno para TRUST_PROXY_HOPS=0 permanecem preservados para rollback integral; nenhum rollback foi executado porque todos os gates passaram e a decisão foi KEEP.
- **OPS-DNS-API** [documented/absent] — Nenhuma alteração DNS foi executada na Window 1; api.agenciagenesismkt.com.br permaneceu NXDOMAIN na verificação externa do closeout.
- **OPS-DNS-APP** [observed/present] — app.agenciagenesismkt.com.br apresentou A 185.158.133.1, sem CNAME ou AAAA, no snapshot do Gate 1.
- **OPS-VERCEL-LINK** [observed/unknown] — O vínculo de app.agenciagenesismkt.com.br com a Vercel não foi comprovado; a Vercel não foi inspecionada por ausência de sessão read-only autorizada.
- **OPS-ACME-CONTACT** [documented/present] — Arthur aprovou contato@agenciagenesismkt.com.br como email de registro ACME para staging e production. A decisão não configura ACME nem autoriza emissão de certificado.
- **OPS-APPROVED-RECOVERY** [documented/present] — Google Drive permanece o destino externo de backup aprovado; RPO, RTO, retenção, implementação e restore comprovado seguem pendentes.
- **OPS-APPROVED-MONITORING** [documented/present] — UptimeRobot sobre /health permanece o destino de monitoramento externo aprovado; política de alertas e implementação seguem pendentes.
- **OPS-GHCR-VISIBILITY** [unknown/unknown] — Há histórico documentado de package GHCR público; este fato preserva a separação entre o destino privado aprovado e observações live.
- **OPS-GHCR-PUBLIC-READ-OBSERVED** [observed/present] — O package GHCR da API aceitou leitura anônima no Gate 1; a transição futura para privado permanece separada.
- **OPS-REAL-DATA** [documented/not-authorized] — Dados reais não estão autorizados.

## Blockers abertos

- **BLOCK-PUBLIC-ORIGIN** — O edge privado e TRUST_PROXY_HOPS=1 estão implantados após KEEP da Window 1; DNS, TCP/80, ACME, certificado, TCP/443 e exposição pública health-only continuam pendentes e exigem preflight e autorizações próprias.
- **BLOCK-WEB-VERCEL-FUNCTIONAL** — O vínculo app./Vercel precisa ser reconciliado antes da futura exposição funcional /api/v1; não bloqueia o edge health-only da 06B.
- **BLOCK-RECOVERY** — Google Drive foi aprovado como destino; RPO, RTO, retenção e restore sintético precisam ser aprovados ou comprovados antes de dados reais.

## Decisões humanas pendentes

- **HD-DNS-OPERATOR-AUTHORITY** — Quem operará o DNS e qual autoridade DNS será usada no preflight da Window 2?
- **HD-DNS-TTL** — Qual TTL será aprovado para o futuro registro A da API na Window 2?
- **HD-CHANGE-WINDOW** — Qual janela operacional será aprovada para a Window 2?
- **HD-AUTHORIZE-DNS-A** — A criação do registro A de api.agenciagenesismkt.com.br para o IPv4 aprovado será autorizada na Window 2?
- **HD-AUTHORIZE-TCP80** — A abertura pública de TCP/80 será autorizada na Window 2 após DNS convergente?
- **HD-AUTHORIZE-ACME-STAGING** — Uma única solicitação ACME staging será autorizada na Window 2 após DNS e TCP/80 comprovados?
- **HD-AUTHORIZE-ACME-PRODUCTION** — A emissão ACME production será autorizada após o staging aprovado?
- **HD-AUTHORIZE-TCP443-PUBLIC-FULL** — TCP/443 e o override public-full serão autorizados após certificado válido?
- **HD-OBSERVATION-DURATION** — Qual duração de observação pública será exigida após cada transição da Window 2?
- **HD-KEEP-OR-REVERT** — Quais critérios e quem decidirá keep ou revert ao fim da observação pública da Window 2?
- **HD-ROLLBACK-OWNER-AUTHORIZATION** — Quem será o owner do rollback da Window 2 e qual autorização poderá acioná-lo?
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
- **OR-WINDOW2-NOT-AUTHORIZED** — A próxima tarefa limita-se ao preflight da Window 2; DNS, TCP/80, ACME, certificado, TCP/443, exposição pública e observação pública não estão autorizados por esta reconciliação.
