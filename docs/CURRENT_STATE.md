<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v1.json -->

# Estado atual

Esta projeção é gerada deterministicamente. Não edite manualmente; a autoridade temporal única é [docs/memory/project-state.v1.json](memory/project-state.v1.json).

- **Revisão de estado:** IF-MATCH-TRANSPORT-SHIM-V2-PRODUCTION-OBSERVED-2026-08-25
- **Atualização documentada:** 2026-08-25T17:13:24.353Z
- **Fase:** 0.8-MVP — Primeira produção mínima viável
- **Último trabalho concluído:** IF-MATCH-TRANSPORT-SHIM-V2-PRODUCTION-OBSERVED — Shim de transporte If-Match integrado, promovido e observado em produção
- **Trabalho vigente:** none — Nenhuma correção deste incidente está ativa. O shim de transporte está integrado, promovido e observado técnica e funcionalmente; cleanup do probe e eventual envio do support packet permanecem tarefas separadas e não autorizadas por este closeout.
- **Próxima tarefa:** PENDING-ROADMAP-PRIORITIZATION — Priorizar o próximo marco do produto a partir dos planos versionados
- **Web integrado na main:** 017ef0056d97147a5e5337494fa339a3f65986ac
- **Revisão fonte da imagem API live:** 0a56a8aee7c64bda59a1981888418e1ad03950c0
- **Revisão do contrato versionado de release API:** containing-commit
- **Revisão do contrato versionado da árvore de release:** containing-commit
- **Fingerprint contratual do bundle current:** SHA-256 derivado do release-manifest.json de papel current no containing commit
- **Fingerprint contratual do bundle rollback:** SHA-256 derivado do release-manifest.json de papel rollback no containing commit
- **Imagem API live:** ghcr.io/arthurportodev/genesis-platform-api@sha256:b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb
- **Imagem API de rollback:** ghcr.io/arthurportodev/genesis-platform-api@sha256:a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a
- **Proveniência da memória e tooling API:** containing-commit

## Estado operacional

A revisão Web 017ef005 está live no deployment Vercel dpl_J6SwpHNDGHL9MUdXLZeNVb1wfwyr, com dpl_9Npu4VnyWatw1vMEforzUv8Mokke preservado para rollback. Smokes técnico, de transporte e funcional passaram; o falso 412 e o Weak ETag estão resolvidos em produção. API, imagem API, banco e concorrência otimista permaneceram inalterados. O probe está preservado e o support packet segue pronto, não enviado.

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
- **OPS-VERCEL-LINK** [observed/absent] — Registro histórico: C4R1 deixou de ser o deployment live e foi superseded pela promoção 10B dpl_3wHMLgJJP6wWAQ3epZzd3GYBLz4Z; dpl_AuunpMMmehaXdXFa5wu52DAMF99P é o rollback Web preservado. O controle durável git.deploymentEnabled=false permanece, sem inferir estado atual de C4R1.
- **OPS-ACME-CONTACT** [observed/present] — O contato aprovado contato@agenciagenesismkt.com.br foi usado na solicitação ACME production única concluída pela Window 2.
- **OPS-APPROVED-RECOVERY** [documented/present] — Google Drive dedicado opera com RPO de 24 horas, frequência de 12 horas, RTO lógico sintético de quatro horas, retenção regular/checkpoint de 30/90 dias, duas cópias verificadas e trash-only; a Window R4 comprovou a ativação e o restore.
- **OPS-RECOVERY-TOOLING** [documented/present] — A 07A incorporou contrato versionado, runners, configuração não secreta, systemd, validação, testes e plano Window R; o tooling futuro classifica e provisiona genesis_backup somente sob autorização explícita, e rejeita OAuth externo que não prove status In production com scope drive.file; nenhum backup, OAuth, role, timer ou restore live foi executado.
- **OPS-RECOVERY-WINDOW-R3** [observed/present] — A Window R3 preservou genesis_backup conforme, identidade age sob custódia dupla e OAuth externo In production com scope drive.file. O checkpoint e o round trip passaram, mas o restore falhou porque o runner exigia SELECT runtime em migrations e três tabelas de idempotência onde produção o nega intencionalmente; o rollback foi trash-only, sem restart, volume ativo, porta publicada ou timer habilitado. A correção candidata torna as quatro negações parte explícita da prova ACL.
- **OPS-RECOVERY-WINDOW-R4** [observed/present] — A Window R4 instalou atomicamente o committed release corrigido sem restart, validou a credencial Drive sem novo OAuth, manteve genesis_backup conforme com zero mutações, comprovou checkpoint cifrado, round trip e restore PostgreSQL 17 isolado em 17 segundos, ativou o timer e observou o primeiro backup regular. Checkpoint e regular formam duas cópias remotas verificadas; não houve acesso ao volume ativo, porta publicada, untrash, purge ou recurso residual.
- **OPS-APPROVED-MONITORING** [documented/present] — UptimeRobot sobre /health permanece o destino de monitoramento externo aprovado; política de alertas e implementação seguem pendentes.
- **OPS-GHCR-VISIBILITY** [observed/present] — A imagem publicada para a application revision 0a56a8aee7c64bda59a1981888418e1ad03950c0 possui manifest digest b45425d7, config digest 1cd06152 e scan Trivy Critical aprovado; a publicação manual foi o run 32401997540.
- **OPS-GHCR-PUBLIC-READ-OBSERVED** [observed/present] — O package GHCR da API aceitou leitura anônima no Gate 1; a transição futura para privado permanece separada.
- **OPS-REAL-DATA** [observed/partial] — Existe uma identidade OWNER real e a organização Porto está ativa. A 10A criou zero Leads, Sessions e Refresh Tokens; nenhum Lead de negócio foi criado durante 10A ou 10B.
- **OPS-MVP08-API-RELEASE-BINDING** [observed/present] — O binding runtime atual seleciona a imagem b45425d7, derivada da application revision 0a56a8ae. O API main f5a11c6 contém tooling de onboarding posterior e não é apresentada como origem da imagem implantada.
- **OPS-MVP08-API-ROLLBACK-BINDING** [observed/present] — A imagem a4dafefa é o rollback atual da API para o deployment 09E; a imagem 56ada pertence ao histórico anterior e não é o rollback operacional vigente.
- **OPS-MVP08-PREFLIGHT-BLOCKED** [observed/present] — Os gaps do preflight 08B foram fechados dentro dos Gates autorizados: bundle versionado, árvore atômica, Vercel Hobby, domínio, DNS, chave de origem, router protegido, smokes e rehearsal foram comprovados sem dados reais.
- **OPS-MVP08-VPS-INTEGRITY-AUDIT** [observed/absent] — remoteTreeBinding=SUPERSEDED. Registro histórico: a auditoria MVP08 vinculava a árvore remota a df7fca7 e registrava REBIND_REQUIRED para aquele closeout. Não se infere nem se reconstrói um rebind. O deployment 09E posterior promoveu a imagem b45425d7, fonte 0a56a8a, preservou a4dafefa como rollback e observou API, PostgreSQL e Traefik saudáveis; esse é o estado runtime vigente.
- **OPS-MVP08-RELEASE-TREE-CONTRACT** [documented/present] — O bundle v2 define onze diretórios, staging root-only, papéis current/rollback, quarentena e renameat2(RENAME_EXCHANGE). O rollback deriva do mesmo containing commit por duas substituições fechadas para a imagem previous-approved. O par exige papéis, imagens e fingerprints distintos, sourceCommit idêntico e todos os demais artefatos iguais; o contrato foi usado no rebuild atômico autorizado e permanece inalterado por esta reconciliação.
- **OPS-MVP08-HUMAN-SECURITY** [documented/partial] — 2FA e recuperação foram confirmados para Vercel, GitHub e Bitwarden. O 2FA da Hostinger permanece pendente sob risco explicitamente aceito por Arthur; nenhuma nova operação Hostinger deve contornar reautenticação ou ampliar esse risco.
- **OPS-MVP08-WEB-RUNTIME-INCIDENT** [observed/present] — O deployment B dpl_7rm5gaRDfvmVEDHjiJb9wFCF8jh9 foi rejeitado e não é elegível: o bundle Node 24 preservava o import ESM sem extensão ../src/server/api-proxy, causando ERR_MODULE_NOT_FOUND em /var/task. O PR #13 corrigiu o specifier para ../src/server/api-proxy.js e adicionou regressão sobre o artefato empacotado.
- **OPS-MVP08-WEB-PREVIEW** [observed/present] — O único Preview autorizado dpl_8jxNbftLPyS3BJ9XtZwJ9A3mk36K, ligado ao commit 5c631fb8c577b0310668204b41f5ace61cfc5cdc, inicializou a Function sem erro de módulo, permaneceu fail-closed e não contatou upstream. Após aprovação técnica, foi excluído e seus aliases passaram a DEPLOYMENT_NOT_FOUND.
- **OPS-MVP08-OPERATIONAL-ROLLBACK** [observed/absent] — Registro histórico superseded: o plano integral MVP08 baseado na imagem 56ada e nos deployments dpl_2VraWZimf1t2x9bGeqTmvRYb3MJr/B4 não é mais o rollback vigente. Após 09E e 10B, o rollback API preservado é a4dafefa e o rollback Web é dpl_AuunpMMmehaXdXFa5wu52DAMF99P; qualquer reversão futura exige autorização própria.
- **OPS-MVP08-FINAL-ARCHITECTURE** [observed/present] — A arquitetura final é Browser → Vercel same-origin /api/v1 → api.agenciagenesismkt.com.br → Traefik com chave de origem → Nest → PostgreSQL privado. O navegador não usa a origem API diretamente e o acesso direto sem chave permanece 404.
- **OPS-MVP08-DNS-TLS** [observed/present] — app.agenciagenesismkt.com.br usa CNAME 3271c7a0f81a40b0.vercel-dns-017.com com TTL 300, confirmado em dois autoritativos e quatro resolvedores públicos, sem A ou AAAA diretos. TLS possui CN/SAN exato, emissor Let's Encrypt YR2 e validade observada até 2026-11-12.
- **OPS-MVP08-ORIGIN-TRUST** [observed/present] — A API b45425d7 está saudável, privada e sem porta pública; o proxy same-origin e login funcionam no domínio final e a origem direta continua protegida. Nenhum segredo foi lido ou registrado nesta reconciliação.
- **OPS-MVP08-WEB-CORRECTIONS** [observed/present] — As correções incorporadas cobrem import ESM empacotado, proveniência do rewrite real da Vercel e snapshot de configuração por invocation, com regressões locais, Preview diagnóstico e validação cloud antes do cutover. C2 e C3 foram aposentadas e não são credenciais ativas.
- **OPS-MVP08-SYNTHETIC-VERIFICATION** [observed/present] — B4 respondeu 503 configuration_unavailable com zero upstream. C4R1 respondeu GET 200, HEAD 200 e OPTIONS 204 com no-store, CDN MISS, CORS da origem final, credentials true e cookie __Host-genesis_csrf Secure, host-only e Path=/; o acesso direto sem chave respondeu 404.
- **OPS-MVP08-REHEARSAL-OBSERVATION** [observed/present] — O rehearsal C4R1 → B4 → C4R1 restaurou o mesmo deployment sem criar outro. Seis amostras sintéticas em aproximadamente cinco minutos aprovaram frontend, Function, health, DNS e bloqueio direto, com zero 5xx inesperado.
- **OPS-MVP08-DATABASE-SCOPE** [observed/present] — O snapshot 08 não continha usuário real. A 10A posteriormente criou, por operação autorizada e transacional, a organização Porto e um OWNER real; nenhuma migration foi executada e nenhum Lead de negócio foi criado.
- **OPS-MVP08-PLAN-BOUNDARY** [documented/partial] — A restrição histórica que proibia qualquer usuário real foi superada pela autorização e execução da 10A. A compatibilidade do plano Vercel para onboarding externo ou uso comercial ampliado permanece uma decisão específica pendente e não bloqueia o uso normal inicial pela organização Porto.
- **OPS-MVP08-CLOSEOUT-FINDINGS** [observed/present] — O closeout operacional encerrou com findings Critical, High e Medium vazios. Deployments, branches, quarentenas, árvores de rollback e evidências foram preservados; eventual limpeza futura de deployments com snapshots de chaves aposentadas é opcional e não bloqueante.
- **OPS-MVP09-API-DEPLOYMENT** [observed/present] — A 09E implantou e observou com resultado KEEP a imagem API b45425d7; a4dafefa foi preservada como rollback. API, PostgreSQL e Traefik terminaram saudáveis, sem migration posterior ao deployment.
- **OPS-MVP09-FIXTURE-DEACTIVATED** [observed/present] — A fixture sintética reversível usada na validação foi encerrada em estado DEACTIVATED; Leads, Sessions e Refresh Tokens sintéticos ativos ficaram em zero, sem hard delete, migration ou alteração de dado real.
- **OPS-MVP09-USABILITY-CLOSURE** [documented/present] — A 09I encerrou o MVP live validado com três gaps de usabilidade identificados; esses gaps foram posteriormente resolvidos e implantados pela 10B.
- **OPS-MVP10A-OWNER-ONBOARDED** [observed/present] — A organização Porto está ativa com exatamente um OWNER real e ativo. A criação privada foi atômica, o login humano passou e nenhuma PII ou credencial da conta é registrada nesta memória.
- **OPS-MVP10A-API-MAIN** [documented/present] — O API main f5a11c6ad5b6f4817198730b8311d27117ee01a7 contém o CLI privado de onboarding OWNER. Essa revisão de tooling não substitui a application revision 0a56a8ae da imagem API live.
- **OPS-MVP10B-USABILITY-CORRECTIONS** [observed/present] — A 10B resolveu em produção o 404 da raiz com / para /app, tornou a etapa do Lead imediatamente persistida e confirmada pelo servidor com restauração em falha, e passou a hidratar o e-mail atual no editor por identidade do Lead.
- **OPS-MVP10D-WEB-INTEGRATED** [observed/present] — O PR Web #18 integrou a correção de equivalência do Weak ETag em ac87eb7 e o PR Web #19 integrou em e1ecc23 a reconciliação Web-first, o bloqueio de auto-deadlock e a preservação do snapshot autenticado durante refresh; ambas as CIs pós-merge passaram.
- **OPS-IFMATCH-WEB-INTEGRATED** [documented/present] — O PR Web #20 foi integrado por squash em 017ef0056d97147a5e5337494fa339a3f65986ac, árvore 5756fda028b91593473d8fe06238485dc24f7938; a CI pós-merge 32870003911 e Validate frontend passaram. Browser usa X-Genesis-If-Match e o proxy materializa If-Match upstream, sem mudança na API ou no banco.
- **OPS-IFMATCH-FALSE-412-FORENSICS** [documented/present] — No evento real, o browser observou um PATCH 412 enquanto Traefik/API observaram o único PATCH como 200, sem retry ou segundo writer; o banco confirmou a mutação de serviceInterest e a revisão 18→19. O falso 412 foi localizado após a resposta da API, sem caminho API/PostgreSQL de commit seguido de stale 412 na mesma execução.
- **OPS-IFMATCH-VERCEL-PROBE** [documented/present] — O probe isolado codex/vercel-if-match-probe em 45001ad8 e dpl_CrSiMzQBJD5ypbxNpKrkdh4MWqPk reproduziu R1: If-Match divergente transformou externamente handler 200 em 412, inclusive sem ETag explícito da resposta. Isso confirma a fronteira Vercel, não o componente interno exato nem uma correção do provedor; support packet pronto, não enviado.
- **OPS-IFMATCH-PRODUCTION-PROMOTED** [observed/present] — O deployment dpl_J6SwpHNDGHL9MUdXLZeNVb1wfwyr da revisão Web 017ef005 foi promovido em 2026-08-25T16:43:46.645Z e ficou Ready, Production e Current em app.agenciagenesismkt.com.br, sem novo build. dpl_9Npu4VnyWatw1vMEforzUv8Mokke permanece preservado para rollback.
- **OPS-IFMATCH-TECHNICAL-CANARY** [documented/present] — Após a promoção, raiz, login, assets e health same-origin passaram com 200 e no-store; não houve 5xx, logs critical/error/fatal ou host_authority_mismatch público. O cookie CSRF sanitizado permaneceu __Host-, Secure, SameSite=Lax, Path=/ e sem Domain. Canary sem sessão, Authorization ou mutação atravessou X-Genesis-If-Match e alcançou auth/API com 401, sem PRECONDITION_FAILED.
- **OPS-IFMATCH-FUNCTIONAL-SMOKE** [documented/present] — O smoke manual autenticado confirmou na primeira tentativa edição condicional de Interesse com X-Genesis-If-Match, sem If-Match no browser ou falso 412; GET 200 confirmou revisão 20 e valor persistido. Adicionar nota, criar próxima ação e mover etapa também passaram na granularidade informada. Weak ETag e falso 412 estão resolvidos em produção, com optimistic concurrency preservada.
- **OPS-MVP09E-HELPER-PROVENANCE** [documented/partial] — O deployment 09E foi executado com script aprovado SHA-256 e99dee6fb4610f9ca470aca8e12f00c4076e60ea45de3f9fb7a4f762208b6db6, preservado na custódia externa 0.8-MVP-09E/deployment-execution. O artefato exato não está comprovadamente versionado na main; isso não afeta o runtime atual, mas exige reconciliar e versionar novamente o procedimento antes de qualquer futuro deployment API.

## Blockers abertos

- Nenhum.

## Decisões humanas pendentes

- **HD-MONITORING** — Qual política de alertas, destinatários e escalonamento será aprovada para o UptimeRobot e os sinais internos?
- **HD-EXTERNAL-ONBOARDING** — Qual política aprovará novos usuários externos e dados comerciais além do uso inicial da organização Porto?
- **HD-COMMERCIAL-HOSTING-PLAN** — Antes de onboarding externo ou uso comercial ampliado, o plano Vercel atual continua técnica e contratualmente compatível?
- **HD-NEXT-MILESTONE** — Qual marco versionado deve suceder o closeout observado do shim de transporte: cleanup operacional, melhoria 0.9/usability ou outro item priorizado?

## Release gates

- **RG-TLS** [passed] — TLS, hostname, CNAME e o caminho funcional same-origin protegido foram comprovados no domínio final; o acesso direto à API sem a chave continua 404.
- **RG-RECOVERY** [passed] — Backup recuperável e restore sintético devem passar antes de dados reais.
- **RG-CROSS-TENANT** [pending] — A evidência atual não é suficiente para aprovar o gate adversarial cross-tenant. Ele permanece pendente para expansão de usuários e dados e não invalida o estado live atual com um OWNER efetivo.
- **RG-WEB-PRODUCTION-PROMOTION** [passed] — A revisão Web 017ef005 recebeu promoção controlada, rollback preservado e observações técnica, de transporte e funcional; o shim eliminou o falso 412 observado sem alterar a concorrência otimista da API.

## Restrições atuais

- **OR-SINGLE-VPS** — A baseline documentada usa uma única VPS e um único failure domain.
- **OR-SINGLE-REPLICA** — A API pública permanece limitada a uma réplica enquanto controles forem process-local.
- **OR-NO-COMMERCIAL-LEADS-OBSERVED** — A 10A e a 10B não criaram Leads de negócio; o fato comprovado é a existência da organização Porto e de um OWNER real ativo, com uso normal inicial do CRM disponível.
- **OR-POSTGRES-PRIVATE** — O PostgreSQL deve permanecer privado, sem binding de porta no host ou exposição direta à Internet.
- **OR-FUNCTIONAL-API-ORIGIN-PROTECTED** — A API funcional é acessível somente pelo proxy same-origin /api/v1 do domínio final e pelo Traefik protegido; a origem direta sem chave permanece 404.
- **OR-VERCEL-HOBBY-TECHNICAL-MVP** — O frontend live e o OWNER real foram aprovados no plano Vercel atual; a adequação técnica e contratual para onboarding externo ou uso comercial ampliado permanece decisão específica pendente.
- **OR-FUTURE-PRODUCTION-MUTATION** — Qualquer futura alteração de produção continua exigindo escopo, rollback e autorização humana explícitos; esta reconciliação documental não concede autorização operacional.
- **OR-IFMATCH-PROBE-PRESERVED** — O probe Vercel e a branch diagnóstica permanecem preservados; o support packet está pronto e não enviado, e a mitigação local ativa não declara correção do provedor nem identifica seu componente interno.
- **OR-API-DEPLOYMENT-HELPER-PROVENANCE** — O script exato executado na 09E está preservado somente na custódia operacional externa e não está comprovadamente versionado na main atual.
- **OR-RHO-OUT-OF-SCOPE** — RHO permanece fora do escopo desta release e não foi consultado ou alterado.
