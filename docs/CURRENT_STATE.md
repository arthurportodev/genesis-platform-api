<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v1.json -->

# Estado atual

Esta projeção é gerada deterministicamente. Não edite manualmente; a autoridade temporal única é [docs/memory/project-state.v1.json](memory/project-state.v1.json).

- **Revisão de estado:** GH-01-COMPLETE
- **Atualização documentada:** 2026-08-15T11:45:00Z
- **Fase:** 0.8-MVP — Primeira produção mínima viável
- **Último trabalho concluído:** 0.8-MVP-08 — Vercel, proxy, domínio e integração frontend/backend
- **Trabalho vigente:** none — A missão 0.8-MVP-08 foi concluída tecnicamente sem usuários ou dados reais. C4R1 está Current e funcional no domínio final, a origem permanece protegida, o rollback está preservado e qualquer próxima missão depende de decisão humana explícita.
- **Próxima tarefa:** 0.8-MVP-09-READINESS-DECISION — Decisão humana sobre escopo, plano de hosting e autorização da próxima missão
- **Web integrado:** b26f4079aa4da735faa881753f5351d377009dcc
- **Revisão da aplicação API:** 9402d067897ab727fb369d7e696a11ba3b9cf68f
- **Revisão do manifesto de release API:** containing-commit
- **Revisão do contrato da árvore de release:** containing-commit
- **Fingerprint do bundle current:** SHA-256 derivado do release-manifest.json de papel current no containing commit
- **Fingerprint do bundle rollback:** SHA-256 derivado do release-manifest.json de papel rollback no containing commit
- **Imagem API autorizada:** ghcr.io/arthurportodev/genesis-platform-api@sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a
- **Imagem API de rollback:** ghcr.io/arthurportodev/genesis-platform-api@sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659
- **Proveniência da memória API:** containing-commit

## Estado operacional

C4R1 está Current e READY no commit Web b26f4079, servindo app.agenciagenesismkt.com.br por CNAME e TLS válidos. O proxy same-origin /api/v1 alcança a API a4daf somente pelo Traefik protegido, com PostgreSQL privado e saudável. B4, A e a imagem 56ada permanecem como rollback; não houve migration, dado ou usuário real.

- **OPS-PRIVATE-BASELINE** [documented/present] — API e PostgreSQL são documentados como instalados em uma baseline privada.
- **OPS-PRIVATE-BASELINE-LIVE** [observed/present] — API e PostgreSQL permaneceram privados e saudáveis no closeout, com IDs preservados, zero reinícios inesperados e sem exposição direta ou bindings públicos.
- **OPS-PUBLIC-PORTS** [observed/present] — A superfície pública final contém somente TCP/22, TCP/80 e TCP/443; as portas 3000, 5432 e 8080 permanecem fechadas.
- **OPS-06A-CONTRACTS** [observed/present] — Os contratos 06A de edge Traefik health-only foram incorporados à API main por PR #41; o CI pós-merge passou sem publicação nem deploy.
- **OPS-APPROVED-EDGE** [documented/present] — A arquitetura aprovada define frontend na Vercel em app.agenciagenesismkt.com.br, API em api.agenciagenesismkt.com.br e Traefik como proxy HTTPS; implementação e estado live são registrados separadamente.
- **OPS-APPROVED-RUNTIME** [documented/present] — A arquitetura aprovada define Hostinger KVM 2, API NestJS em container, PostgreSQL em rede privada e somente produção inicialmente, sem staging.
- **OPS-APPROVED-DELIVERY** [documented/present] — O destino aprovado usa GHCR privado e deploy inicial manual com aprovação humana; a visibilidade live observada é registrada separadamente.
- **OPS-COMMITTED-RELEASE-BUNDLE** [observed/present] — O bundle committed-release validado do squash 06A foi transferido, revalidado na VPS e promovido atomicamente como release ativo da Window 1; o release anterior foi preservado.
- **OPS-API-IMAGE-PRESERVED** [observed/present] — No Checkpoint C da Window 1, a API usou o digest então aprovado, permaneceu saudável com TRUST_PROXY_HOPS=1 e sem binding no host; somente a API foi recriada, com downtime medido de 4,711 segundos.
- **OPS-TRAEFIK-IMAGE-APPROVED** [observed/present] — Na Window 2, a imagem Traefik aprovada por digest imutável para linux/amd64 foi ativada em modo public-full health-only, sem Docker socket ou dashboard público.
- **OPS-VPS-READINESS** [observed/present] — A observação pública registrou 30/30 amostras PASS, zero falhas, zero respostas 5xx, CPU máxima de 39,08%, memória máxima de 8,21% e disco em 5%, sem disparar rollback.
- **OPS-TRAEFIK-LIVE** [observed/present] — Na Window 2, o Traefik executou em modo public-full health-only com TRUST_PROXY_HOPS=1 e restart count zero; GET /health foi a única rota pública bem-sucedida e a matriz fail-closed passou naquele checkpoint.
- **OPS-ACME-STATE** [observed/present] — O estado ACME staging foi preservado e reutilizado sem novo ciclo; ocorreu uma única solicitação production e um certificado production foi emitido, sem consulta a logs brutos nem a conteúdo ou hash dos arquivos ACME.
- **OPS-PUBLIC-CERTIFICATE** [observed/present] — Um certificado Let's Encrypt production confiável está ativo para api.agenciagenesismkt.com.br, com SAN e hostname corretos e renovação administrada pelo Traefik.
- **OPS-PUBLIC-HTTPS** [observed/present] — Na Window 2, TCP/443 ficou público e GET https://api.agenciagenesismkt.com.br/health retornou 200; /api/v1, /api/v1/health, dashboard, métodos não permitidos e demais rotas funcionais permaneceram fail-closed naquele checkpoint.
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
- **OPS-VERCEL-LINK** [observed/present] — O projeto Vercel Hobby genesis-platform-web foi reconciliado em sessão autenticada: C4R1 está Current e READY, app.agenciagenesismkt.com.br possui configuração válida Production, auto-deploy Git está desativado e não há bypass credential de automação.
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
- **OPS-MVP08-WEB-INTEGRATED** [observed/present] — A revisão Web integrada, implantada e autoritativa para a 08 é b26f4079aa4da735faa881753f5351d377009dcc, tree a9d71a2e3b4054f6307a1f7d677f81ceaf874cde, resultado do squash do PR #15 após CI e verificação independentes.
- **OPS-MVP08-PREFLIGHT-BLOCKED** [observed/present] — Os gaps do preflight 08B foram fechados dentro dos Gates autorizados: bundle versionado, árvore atômica, Vercel Hobby, domínio, DNS, chave de origem, router protegido, smokes e rehearsal foram comprovados sem dados reais.
- **OPS-MVP08-VPS-INTEGRITY-AUDIT** [observed/present] — remoteTreeBinding=REBIND_REQUIRED. No início deste closeout, a árvore remota estava íntegra e vinculada ao API main df7fca7392b90a788903797a2e30cb9f4b6cb05d, com fingerprints current 63312f7a848cd8646c9d7eefb965ba3f15e2cde6effdd0a7b5b3e62c26fb8d2e e rollback 2cdfb05a2392ab3527bb95f069e7fd70ae7db8403ea19824b62ee45b5583faf5. Como a memória faz parte da identidade containing-commit, o squash deste closeout exige rebind atômico pós-merge, sem alteração de bytes de runtime ou restart.
- **OPS-MVP08-RELEASE-TREE-CONTRACT** [documented/present] — O bundle v2 define onze diretórios, staging root-only, papéis current/rollback, quarentena e renameat2(RENAME_EXCHANGE). O rollback deriva do mesmo containing commit por duas substituições fechadas para a imagem previous-approved. O par exige papéis, imagens e fingerprints distintos, sourceCommit idêntico e todos os demais artefatos iguais; o contrato foi usado no rebuild atômico autorizado e permanece inalterado por esta reconciliação.
- **OPS-MVP08-HUMAN-SECURITY** [documented/partial] — 2FA e recuperação foram confirmados para Vercel, GitHub e Bitwarden. O 2FA da Hostinger permanece pendente sob risco explicitamente aceito por Arthur; nenhuma nova operação Hostinger deve contornar reautenticação ou ampliar esse risco.
- **OPS-MVP08-WEB-RUNTIME-INCIDENT** [observed/present] — O deployment B dpl_7rm5gaRDfvmVEDHjiJb9wFCF8jh9 foi rejeitado e não é elegível: o bundle Node 24 preservava o import ESM sem extensão ../src/server/api-proxy, causando ERR_MODULE_NOT_FOUND em /var/task. O PR #13 corrigiu o specifier para ../src/server/api-proxy.js e adicionou regressão sobre o artefato empacotado.
- **OPS-MVP08-WEB-PREVIEW** [observed/present] — O único Preview autorizado dpl_8jxNbftLPyS3BJ9XtZwJ9A3mk36K, ligado ao commit 5c631fb8c577b0310668204b41f5ace61cfc5cdc, inicializou a Function sem erro de módulo, permaneceu fail-closed e não contatou upstream. Após aprovação técnica, foi excluído e seus aliases passaram a DEPLOYMENT_NOT_FOUND.
- **OPS-MVP08-OPERATIONAL-ROLLBACK** [observed/present] — O rollback integral preservado é: remover o CNAME app para retornar a NODATA, promover A dpl_2VraWZimf1t2x9bGeqTmvRYb3MJr, restaurar a imagem 56ada, router health-only, FRONTEND_URL=https://genesis.invalid e remover ou desativar a origin key. B4 dpl_9TsE7H1V7CSFuV4f5PYb5ckWswzi é o rollback Web fail-closed imediato.
- **OPS-MVP08-FINAL-ARCHITECTURE** [observed/present] — A arquitetura final é Browser → Vercel same-origin /api/v1 → api.agenciagenesismkt.com.br → Traefik com chave de origem → Nest → PostgreSQL privado. O navegador não usa a origem API diretamente e o acesso direto sem chave permanece 404.
- **OPS-MVP08-VERCEL-DEPLOYMENTS** [observed/present] — C4R1 dpl_AuunpMMmehaXdXFa5wu52DAMF99P está Current e READY no commit b26f4079. B4 dpl_9TsE7H1V7CSFuV4f5PYb5ckWswzi, A dpl_2VraWZimf1t2x9bGeqTmvRYb3MJr e o C4 funcionalmente rejeitado dpl_7qaTzkffYxSHdDoKtHkQtvjPNJxJ permanecem retidos. Auto-deploy Git está desativado e há zero bypass credentials.
- **OPS-MVP08-DNS-TLS** [observed/present] — app.agenciagenesismkt.com.br usa CNAME 3271c7a0f81a40b0.vercel-dns-017.com com TTL 300, confirmado em dois autoritativos e quatro resolvedores públicos, sem A ou AAAA diretos. TLS possui CN/SAN exato, emissor Let's Encrypt YR2 e validade observada até 2026-11-12.
- **OPS-MVP08-ORIGIN-TRUST** [observed/present] — A API a4daf está saudável, privada e sem porta pública, com FRONTEND_URL=https://app.agenciagenesismkt.com.br, router funcional protegido e web proxy attestation=true. A origin key existe somente por metadados root:root, modo 0600 e tamanho 64; seu valor nunca foi lido. Na Vercel ela é Sensitive e apenas Production; o target não secreto é https://api.agenciagenesismkt.com.br/.
- **OPS-MVP08-WEB-CORRECTIONS** [observed/present] — As correções incorporadas cobrem import ESM empacotado, proveniência do rewrite real da Vercel e snapshot de configuração por invocation, com regressões locais, Preview diagnóstico e validação cloud antes do cutover. C2 e C3 foram aposentadas e não são credenciais ativas.
- **OPS-MVP08-SYNTHETIC-VERIFICATION** [observed/present] — B4 respondeu 503 configuration_unavailable com zero upstream. C4R1 respondeu GET 200, HEAD 200 e OPTIONS 204 com no-store, CDN MISS, CORS da origem final, credentials true e cookie __Host-genesis_csrf Secure, host-only e Path=/; o acesso direto sem chave respondeu 404.
- **OPS-MVP08-REHEARSAL-OBSERVATION** [observed/present] — O rehearsal C4R1 → B4 → C4R1 restaurou o mesmo deployment sem criar outro. Seis amostras sintéticas em aproximadamente cinco minutos aprovaram frontend, Function, health, DNS e bloqueio direto, com zero 5xx inesperado.
- **OPS-MVP08-DATABASE-SCOPE** [observed/present] — PostgreSQL permaneceu saudável, privado e sem restart; nenhuma migration, alteração de banco, usuário real ou dado real foi executado. RHO permaneceu fora do escopo.
- **OPS-MVP08-PLAN-BOUNDARY** [documented/present] — A Vercel permanece no plano Hobby exclusivamente para validação técnica não comercial do MVP. Usuários reais, dados reais e operação comercial não estão autorizados; plano, custos e compatibilidade contratual devem ser revistos antes da MVP-09 comercial ou de produção com usuários.
- **OPS-MVP08-CLOSEOUT-FINDINGS** [observed/present] — O closeout operacional encerrou com findings Critical, High e Medium vazios. Deployments, branches, quarentenas, árvores de rollback e evidências foram preservados; eventual limpeza futura de deployments com snapshots de chaves aposentadas é opcional e não bloqueante.

## Blockers abertos

- Nenhum.

## Decisões humanas pendentes

- **HD-MONITORING** — Qual política de alertas, destinatários e escalonamento será aprovada para o UptimeRobot e os sinais internos?
- **HD-REAL-DATA** — Quais primeiros usuários e dados reais poderão ser autorizados, e em qual momento?
- **HD-MVP09-HOSTING-PLAN** — Antes da MVP-09 comercial ou de produção com usuários, o plano Hobby continua técnica e contratualmente compatível ou será necessário um novo Gate de plano, custo e pagamento?

## Release gates

- **RG-TLS** [passed] — TLS, hostname, CNAME e o caminho funcional same-origin protegido foram comprovados no domínio final; o acesso direto à API sem a chave continua 404.
- **RG-RECOVERY** [passed] — Backup recuperável e restore sintético devem passar antes de dados reais.
- **RG-CROSS-TENANT** [pending] — Smoke funcional e teste adversarial cross-tenant devem passar antes dos primeiros usuários.

## Restrições atuais

- **OR-SINGLE-VPS** — A baseline documentada usa uma única VPS e um único failure domain.
- **OR-SINGLE-REPLICA** — A API pública permanece limitada a uma réplica enquanto controles forem process-local.
- **OR-NO-REAL-DATA** — Dados reais permanecem não autorizados.
- **OR-POSTGRES-PRIVATE** — O PostgreSQL deve permanecer privado, sem binding de porta no host ou exposição direta à Internet.
- **OR-FUNCTIONAL-API-ORIGIN-PROTECTED** — A API funcional é acessível somente pelo proxy same-origin /api/v1 do domínio final e pelo Traefik protegido; a origem direta sem chave permanece 404.
- **OR-VERCEL-HOBBY-TECHNICAL-MVP** — A Vercel Hobby é usada somente para validação técnica não comercial, sem usuários ou dados reais e sem autorização de upgrade, trial ou pagamento.
- **OR-MVP08-NO-PRODUCTION-MUTATION** — Após o closeout, C4R1, DNS, domínio, variáveis, chave, router, imagens, banco e release tree não podem ser alterados sem novo Gate humano da próxima missão.
- **OR-RHO-OUT-OF-SCOPE** — RHO permanece fora do escopo desta release e não foi consultado ou alterado.
