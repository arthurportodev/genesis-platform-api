<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v1.json -->

# Estado atual

Esta projeção é gerada deterministicamente. Não edite manualmente; a autoridade temporal única é [docs/memory/project-state.v1.json](memory/project-state.v1.json).

- **Revisão de estado:** GH-01-COMPLETE
- **Atualização documentada:** 2026-08-12T13:32:38.1112510Z
- **Fase:** 0.8-MVP — Primeira produção mínima viável
- **Último trabalho concluído:** 0.8-MVP-06B — HTTPS público health-only
- **Trabalho vigente:** in-progress — A 0.8-MVP-07 foi iniciada: a 07A incorporou contrato e tooling de recovery sem operação live; a 07B é o trabalho vigente e exige gates próprios de credencial, produção e merge.
- **Próxima tarefa:** 0.8-MVP-07B — Window R de backup externo e restore comprovado
- **Web integrado:** fa4193fc28751d64923be824d293367499d4fba0
- **Proveniência da API:** containing-commit

## Estado operacional

A 0.8-MVP-06B terminou em KEEP com api.agenciagenesismkt.com.br publicada por HTTPS exclusivamente para GET /health. TCP/80 redireciona para HTTPS, TCP/443 usa certificado Let's Encrypt production válido e as rotas funcionais permanecem fail-closed; API e PostgreSQL continuam privados e saudáveis.

- **OPS-PRIVATE-BASELINE** [documented/present] — API e PostgreSQL são documentados como instalados em uma baseline privada.
- **OPS-PRIVATE-BASELINE-LIVE** [observed/present] — API e PostgreSQL permaneceram privados e saudáveis no closeout, com IDs preservados, zero reinícios inesperados e sem exposição direta ou bindings públicos.
- **OPS-PUBLIC-PORTS** [observed/present] — A superfície pública final contém somente TCP/22, TCP/80 e TCP/443; as portas 3000, 5432 e 8080 permanecem fechadas.
- **OPS-06A-CONTRACTS** [observed/present] — Os contratos 06A de edge Traefik health-only foram incorporados à API main por PR #41; o CI pós-merge passou sem publicação nem deploy.
- **OPS-APPROVED-EDGE** [documented/present] — A arquitetura aprovada define frontend na Vercel em app.agenciagenesismkt.com.br, API em api.agenciagenesismkt.com.br e Traefik como proxy HTTPS; implementação e estado live são registrados separadamente.
- **OPS-APPROVED-RUNTIME** [documented/present] — A arquitetura aprovada define Hostinger KVM 2, API NestJS em container, PostgreSQL em rede privada e somente produção inicialmente, sem staging.
- **OPS-APPROVED-DELIVERY** [documented/present] — O destino aprovado usa GHCR privado e deploy inicial manual com aprovação humana; a visibilidade live observada é registrada separadamente.
- **OPS-COMMITTED-RELEASE-BUNDLE** [observed/present] — O bundle committed-release validado do squash 06A foi transferido, revalidado na VPS e promovido atomicamente como release ativo da Window 1; o release anterior foi preservado.
- **OPS-API-IMAGE-PRESERVED** [observed/present] — A API usa o digest aprovado, está saudável com TRUST_PROXY_HOPS=1 e sem binding no host; somente a API foi recriada no Checkpoint C, com downtime medido de 4,711 segundos.
- **OPS-TRAEFIK-IMAGE-APPROVED** [observed/present] — A imagem Traefik aprovada por digest imutável para linux/amd64 está ativa em modo public-full health-only, sem Docker socket ou dashboard público.
- **OPS-VPS-READINESS** [observed/present] — A observação pública registrou 30/30 amostras PASS, zero falhas, zero respostas 5xx, CPU máxima de 39,08%, memória máxima de 8,21% e disco em 5%, sem disparar rollback.
- **OPS-TRAEFIK-LIVE** [observed/present] — O Traefik está running em modo public-full health-only com TRUST_PROXY_HOPS=1 e restart count zero; GET /health é a única rota pública bem-sucedida e a matriz fail-closed passou.
- **OPS-ACME-STATE** [observed/present] — O estado ACME staging foi preservado e reutilizado sem novo ciclo; ocorreu uma única solicitação production e um certificado production foi emitido, sem consulta a logs brutos nem a conteúdo ou hash dos arquivos ACME.
- **OPS-PUBLIC-CERTIFICATE** [observed/present] — Um certificado Let's Encrypt production confiável está ativo para api.agenciagenesismkt.com.br, com SAN e hostname corretos e renovação administrada pelo Traefik.
- **OPS-PUBLIC-HTTPS** [observed/present] — TCP/443 está público e GET https://api.agenciagenesismkt.com.br/health retorna 200; /api/v1, /api/v1/health, dashboard, métodos não permitidos e demais rotas funcionais permanecem fail-closed.
- **OPS-PUBLIC-HTTP-BINDINGS** [observed/present] — TCP/80 e TCP/443 estão públicos no Traefik; requisições HTTP em TCP/80 são redirecionadas para HTTPS.
- **OPS-06B-DEPLOYMENT** [observed/present] — A 0.8-MVP-06B foi concluída com decisão KEEP e HTTPS público estritamente health-only; nenhuma imagem foi publicada, nenhum application deploy ocorreu e nenhuma rota funcional ou dado real foi liberado.
- **OPS-06B-WINDOW2-OBSERVATION** [observed/present] — A observação mínima foi concluída com 30/30 amostras PASS, zero falhas, zero respostas 5xx, zero reinícios inesperados e zero respostas funcionais de sucesso.
- **OPS-06B-SCOPE-LIMITS** [observed/present] — O closeout registrou zero publicação de imagem, application deploy, operação Vercel, UptimeRobot ou GHCR, migration, usuário ou dado real; o rollback permanece preservado.
- **OPS-06B-WINDOW1-OBSERVATION** [observed/present] — A observação privada concluiu 61 amostras em 3.603 segundos, sem falha de health ou readiness, reinício inesperado, exposição pública, alteração de estado ACME ou critério de rollback.
- **OPS-06B-WINDOW1-PROBE** [observed/present] — O probe sintético privado autorizado comprovou rate limiting, auditoria sanitizada e rejeição do forwarded header forjado, sem usuário ou dado real e sem editar ou apagar registros.
- **OPS-06B-WINDOW1-KEEP** [observed/present] — A Window 1 terminou em KEEP mantendo o edge privado e TRUST_PROXY_HOPS=1 naquele checkpoint; a Window 2 foi autorizada separadamente e posteriormente concluiu o HTTPS público health-only.
- **OPS-06B-ROLLBACK-READY** [observed/present] — O release anterior e o procedimento de retorno permanecem preservados para rollback integral; nenhum rollback foi executado na Window 2 porque todos os critérios passaram e a decisão foi KEEP.
- **OPS-DNS-API** [observed/present] — api.agenciagenesismkt.com.br possui um único registro A para 147.79.82.44, sem AAAA ou CNAME no closeout.
- **OPS-DNS-APP** [observed/present] — app.agenciagenesismkt.com.br apresentou A 185.158.133.1, sem CNAME ou AAAA, no snapshot do Gate 1.
- **OPS-VERCEL-LINK** [observed/unknown] — O vínculo de app.agenciagenesismkt.com.br com a Vercel não foi comprovado; a Vercel não foi inspecionada por ausência de sessão read-only autorizada.
- **OPS-ACME-CONTACT** [observed/present] — O contato aprovado contato@agenciagenesismkt.com.br foi usado na solicitação ACME production única concluída pela Window 2.
- **OPS-APPROVED-RECOVERY** [documented/present] — Google Drive dedicado foi aprovado com RPO de 24 horas, frequência de 12 horas, RTO lógico sintético de quatro horas, retenção regular/checkpoint de 30/90 dias, duas cópias verificadas e trash-only; operação e restore comprovado seguem para a 07B.
- **OPS-RECOVERY-TOOLING** [documented/present] — A 07A incorporou contrato versionado, runners, configuração não secreta, systemd, validação, testes e plano Window R; nenhum backup, OAuth, timer ou restore live foi executado.
- **OPS-APPROVED-MONITORING** [documented/present] — UptimeRobot sobre /health permanece o destino de monitoramento externo aprovado; política de alertas e implementação seguem pendentes.
- **OPS-GHCR-VISIBILITY** [unknown/unknown] — Há histórico documentado de package GHCR público; este fato preserva a separação entre o destino privado aprovado e observações live.
- **OPS-GHCR-PUBLIC-READ-OBSERVED** [observed/present] — O package GHCR da API aceitou leitura anônima no Gate 1; a transição futura para privado permanece separada.
- **OPS-REAL-DATA** [documented/not-authorized] — Dados reais não estão autorizados.

## Blockers abertos

- **BLOCK-WEB-VERCEL-FUNCTIONAL** — O vínculo app./Vercel precisa ser reconciliado antes da futura exposição funcional /api/v1; não bloqueia o edge health-only da 06B.
- **BLOCK-RECOVERY** — Contrato e parâmetros de recovery foram aprovados e incorporados pela 07A; credenciais, operação Google Drive, backup externo e restore sintético ainda precisam ser comprovados na 07B antes de dados reais.

## Decisões humanas pendentes

- **HD-WEB-VERCEL-RECONCILIATION** — Como app.agenciagenesismkt.com.br e a Vercel serão reconciliados antes do proxy funcional /api/v1?
- **HD-MONITORING** — Qual política de alertas, destinatários e escalonamento será aprovada para o UptimeRobot e os sinais internos?
- **HD-REAL-DATA** — Quais primeiros usuários e dados reais poderão ser autorizados, e em qual momento?

## Release gates

- **RG-TLS** [passed] — Traefik, HTTPS e hostname foram comprovados exclusivamente para public HTTPS health-only; o gate não autoriza /api/v1 nem qualquer rota funcional.
- **RG-RECOVERY** [pending] — Backup recuperável e restore sintético devem passar antes de dados reais.
- **RG-CROSS-TENANT** [pending] — Smoke funcional e teste adversarial cross-tenant devem passar antes dos primeiros usuários.

## Restrições atuais

- **OR-SINGLE-VPS** — A baseline documentada usa uma única VPS e um único failure domain.
- **OR-SINGLE-REPLICA** — A API pública permanece limitada a uma réplica enquanto controles forem process-local.
- **OR-NO-REAL-DATA** — Dados reais permanecem não autorizados.
- **OR-POSTGRES-PRIVATE** — O PostgreSQL deve permanecer privado, sem binding de porta no host ou exposição direta à Internet.
- **OR-FUNCTIONAL-API-FAIL-CLOSED** — A API funcional /api/v1 permanece fail-closed; a 06B limita a exposição pública ao health-only.
- **OR-PUBLIC-HEALTH-ONLY** — A exposição pública permanece limitada a GET /health por HTTPS; /api/v1, demais rotas funcionais, dashboard e métodos não permitidos continuam fail-closed.
