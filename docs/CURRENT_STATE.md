<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v1.json -->

# Estado atual

Esta projeção é gerada deterministicamente. Não edite manualmente; a autoridade temporal única é [docs/memory/project-state.v1.json](memory/project-state.v1.json).

- **Revisão de estado:** GH-01-COMPLETE
- **Atualização documentada:** 2026-08-14T17:22:04Z
- **Fase:** 0.8-MVP — Primeira produção mínima viável
- **Último trabalho concluído:** 0.8-MVP-08-WEB-RUNTIME-REMEDIATION — Correção do runtime Web e Preview controlado
- **Trabalho vigente:** blocked — A correção Web foi integrada e o Preview controlado foi aprovado e removido, mas a produção continua no rollback declarado. A nova memória containing-commit altera os fingerprints dos bundles, portanto a árvore remota precisa de rebind antes de qualquer novo Gate operacional ou retry de produção.
- **Próxima tarefa:** 0.8-MVP-08B-RELEASE-TREE-REBIND-AND-OPERATIONAL-RETRY-GATE — Rebind da árvore de release e novo Gate de retry operacional
- **Web integrado:** 33e99bfcfb87375a801ac49343c28a9fe76e2bb2
- **Revisão da aplicação API:** 9402d067897ab727fb369d7e696a11ba3b9cf68f
- **Revisão do manifesto de release API:** containing-commit
- **Revisão do contrato da árvore de release:** containing-commit
- **Fingerprint do bundle current:** SHA-256 derivado do release-manifest.json de papel current no containing commit
- **Fingerprint do bundle rollback:** SHA-256 derivado do release-manifest.json de papel rollback no containing commit
- **Imagem API autorizada:** ghcr.io/arthurportodev/genesis-platform-api@sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a
- **Imagem API de rollback:** ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659
- **Proveniência da memória API:** containing-commit

## Estado operacional

Production A permanece current; B foi rejeitado por falha ESM e o Web corrigido foi validado em Preview e integrado sem promoção. A operação funcional foi revertida: a VPS executa 56ada com FRONTEND_URL=https://genesis.invalid, router health-only e origin key ausente. A árvore remota é íntegra para os bundles de 6930b2e7, mas não corresponde aos novos fingerprints containing-commit; produção não foi retomada.

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
- **OPS-VERCEL-LINK** [observed/partial] — O projeto Vercel e seus deployments foram inspecionados em sessão autenticada: Production A permanece current, B está rejeitado e o Preview corretivo foi removido. Nenhum custom domain ou alias app.agenciagenesismkt.com.br foi associado; o vínculo funcional continua pendente.
- **OPS-ACME-CONTACT** [observed/present] — O contato aprovado contato@agenciagenesismkt.com.br foi usado na solicitação ACME production única concluída pela Window 2.
- **OPS-APPROVED-RECOVERY** [documented/present] — Google Drive dedicado opera com RPO de 24 horas, frequência de 12 horas, RTO lógico sintético de quatro horas, retenção regular/checkpoint de 30/90 dias, duas cópias verificadas e trash-only; a Window R4 comprovou a ativação e o restore.
- **OPS-RECOVERY-TOOLING** [documented/present] — A 07A incorporou contrato versionado, runners, configuração não secreta, systemd, validação, testes e plano Window R; o tooling futuro classifica e provisiona genesis_backup somente sob autorização explícita, e rejeita OAuth externo que não prove status In production com scope drive.file; nenhum backup, OAuth, role, timer ou restore live foi executado.
- **OPS-RECOVERY-WINDOW-R3** [observed/present] — A Window R3 preservou genesis_backup conforme, identidade age sob custódia dupla e OAuth externo In production com scope drive.file. O checkpoint e o round trip passaram, mas o restore falhou porque o runner exigia SELECT runtime em migrations e três tabelas de idempotência onde produção o nega intencionalmente; o rollback foi trash-only, sem restart, volume ativo, porta publicada ou timer habilitado. A correção candidata torna as quatro negações parte explícita da prova ACL.
- **OPS-RECOVERY-WINDOW-R4** [observed/present] — A Window R4 instalou atomicamente o committed release corrigido sem restart, validou a credencial Drive sem novo OAuth, manteve genesis_backup conforme com zero mutações, comprovou checkpoint cifrado, round trip e restore PostgreSQL 17 isolado em 17 segundos, ativou o timer e observou o primeiro backup regular. Checkpoint e regular formam duas cópias remotas verificadas; não houve acesso ao volume ativo, porta publicada, untrash, purge ou recurso residual.
- **OPS-APPROVED-MONITORING** [documented/present] — UptimeRobot sobre /health permanece o destino de monitoramento externo aprovado; política de alertas e implementação seguem pendentes.
- **OPS-GHCR-VISIBILITY** [observed/present] — O package GHCR da API está publicamente legível; digest a4daf, config ba67, plataforma linux/amd64 e provenance da application revision 9402d067 foram revalidados sem autenticação.
- **OPS-GHCR-PUBLIC-READ-OBSERVED** [observed/present] — O package GHCR da API aceitou leitura anônima no Gate 1; a transição futura para privado permanece separada.
- **OPS-REAL-DATA** [documented/not-authorized] — Dados reais não estão autorizados.
- **OPS-MVP08-API-RELEASE-BINDING** [documented/present] — O caminho normal de promoção e o manifesto do bundle selecionam exclusivamente a imagem a4daf em linux/amd64, com config ba67 e application revision 9402d067; a release-manifest revision é resolvida pelo containing commit corretivo.
- **OPS-MVP08-API-ROLLBACK-BINDING** [documented/present] — A imagem 56ada permanece registrada como rollback anterior e recovery binding; validators rejeitam sua seleção pelo caminho normal de promoção.
- **OPS-MVP08-WEB-INTEGRATED** [observed/present] — A revisão Web integrada e autoritativa para a 08 é 33e99bfcfb87375a801ac49343c28a9fe76e2bb2, resultado do squash do PR #13 após CI e verificação independentes.
- **OPS-MVP08-PREFLIGHT-BLOCKED** [observed/partial] — A 08B permanece fail-closed após rollback: Production A está current, a VPS executa 56ada com FRONTEND_URL=https://genesis.invalid, router health-only e origin key ausente. Rebind dos novos bundles, configuração de origem/domínio/DNS e novo Gate operacional ainda são necessários antes de qualquer retry.
- **OPS-MVP08-VPS-INTEGRITY-AUDIT** [observed/present] — remoteTreeBinding=REBIND_REQUIRED. A árvore remota foi reconstruída atomicamente e verificada para o par committed-release derivado de 6930b2e7; o rollback operacional subsequente preservou o runtime 56ada. Como esta reconciliação muda o containing commit, a árvore continua íntegra para o bundle anterior, mas exige rebind para os novos fingerprints.
- **OPS-MVP08-RELEASE-TREE-CONTRACT** [documented/present] — O bundle v2 define onze diretórios, staging root-only, papéis current/rollback, quarentena e renameat2(RENAME_EXCHANGE). O rollback deriva do mesmo containing commit por duas substituições fechadas para a imagem previous-approved. O par exige papéis, imagens e fingerprints distintos, sourceCommit idêntico e todos os demais artefatos iguais; o contrato foi usado no rebuild atômico autorizado e permanece inalterado por esta reconciliação.
- **OPS-MVP08-HUMAN-SECURITY** [documented/partial] — 2FA e recuperação foram confirmados para Vercel, GitHub e Bitwarden. O 2FA da Hostinger permanece pendente por decisão de risco humana explícita; a sessão autenticada foi usada somente dentro das janelas autorizadas e nova autenticação continua fail-closed.
- **OPS-MVP08-WEB-RUNTIME-INCIDENT** [observed/present] — O deployment B dpl_7rm5gaRDfvmVEDHjiJb9wFCF8jh9 foi rejeitado e não é elegível: o bundle Node 24 preservava o import ESM sem extensão ../src/server/api-proxy, causando ERR_MODULE_NOT_FOUND em /var/task. O PR #13 corrigiu o specifier para ../src/server/api-proxy.js e adicionou regressão sobre o artefato empacotado.
- **OPS-MVP08-WEB-PREVIEW** [observed/present] — O único Preview autorizado dpl_8jxNbftLPyS3BJ9XtZwJ9A3mk36K, ligado ao commit 5c631fb8c577b0310668204b41f5ace61cfc5cdc, inicializou a Function sem erro de módulo, permaneceu fail-closed e não contatou upstream. Após aprovação técnica, foi excluído e seus aliases passaram a DEPLOYMENT_NOT_FOUND.
- **OPS-MVP08-OPERATIONAL-ROLLBACK** [observed/present] — Production A dpl_2VraWZimf1t2x9bGeqTmvRYb3MJr no commit fa4193fc permanece current e inalterada; B foi retido apenas para diagnóstico. A VPS continua na imagem 56ada, FRONTEND_URL=https://genesis.invalid, router health-only e origin key ausente; nenhuma retomada de produção, alteração DNS, segredo ou dado real ocorreu nesta correção.

## Blockers abertos

- **BLOCK-WEB-VERCEL-FUNCTIONAL** — O runtime Web corrigido foi integrado e o Preview controlado foi removido, mas Production A continua sem custom domain funcional. Origin key, vínculo de domínio, DNS, smoke operacional e autorização de retry ainda precisam ser fechados antes da exposição /api/v1.
- **BLOCK-VPS-RELEASE-TREE-INTEGRITY** — A árvore /opt/genesis/release é íntegra para o par de bundles derivado do API main 6930b2e7, mas os novos fingerprints containing-commit desta reconciliação exigem bundles committed-release novos e rebind antes de qualquer retry operacional.

## Decisões humanas pendentes

- **HD-MVP08-OPERATIONAL-GATE** — Conceder um novo Gate operacional somente após rebind dos bundles, revalidação da árvore remota, inventários externos e allowlist exata do retry estarem fechados?
- **HD-MVP08-KEEP-ROLLBACK** — Após o smoke sintético dividido, manter a release ou executar rollback independente de Web, API e DNS?
- **HD-MONITORING** — Qual política de alertas, destinatários e escalonamento será aprovada para o UptimeRobot e os sinais internos?
- **HD-REAL-DATA** — Quais primeiros usuários e dados reais poderão ser autorizados, e em qual momento?

## Release gates

- **RG-TLS** [passed] — Traefik, HTTPS e hostname foram comprovados exclusivamente para public HTTPS health-only; o gate não autoriza /api/v1 nem qualquer rota funcional.
- **RG-RECOVERY** [passed] — Backup recuperável e restore sintético devem passar antes de dados reais.
- **RG-CROSS-TENANT** [pending] — Smoke funcional e teste adversarial cross-tenant devem passar antes dos primeiros usuários.

## Restrições atuais

- **OR-SINGLE-VPS** — A baseline documentada usa uma única VPS e um único failure domain.
- **OR-SINGLE-REPLICA** — A API pública permanece limitada a uma réplica enquanto controles forem process-local.
- **OR-NO-REAL-DATA** — Dados reais permanecem não autorizados.
- **OR-POSTGRES-PRIVATE** — O PostgreSQL deve permanecer privado, sem binding de porta no host ou exposição direta à Internet.
- **OR-FUNCTIONAL-API-FAIL-CLOSED** — A API funcional /api/v1 permanece fail-closed; a 06B limita a exposição pública ao health-only.
- **OR-PUBLIC-HEALTH-ONLY** — A exposição pública permanece limitada a GET /health por HTTPS; /api/v1, demais rotas funcionais, dashboard e métodos não permitidos continuam fail-closed.
- **OR-MVP08-NO-PRODUCTION-MUTATION** — Após o rollback operacional e a correção Web, nenhuma nova mutação de VPS, Vercel, Hostinger, secret, domínio, router funcional ou DNS está autorizada; Production A e o runtime 56ada devem permanecer inalterados.
