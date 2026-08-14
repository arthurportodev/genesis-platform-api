# Segurança

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

Este documento contém invariantes e controles de segurança duráveis. Status de
release, restrições atuais e observações operacionais são resolvidos em
`docs/memory/project-state.v1.json`.

## Credenciais e senhas

- Senhas usam Argon2id com `memoryCost: 65536`, `timeCost: 3` e `parallelism: 1`.
- Política atual: 10 a 128 caracteres e ao menos um caractere não branco; a senha não é normalizada ou truncada.
- Verificação de login executa hash dummy quando o usuário não possui credencial, reduzindo diferença observável.
- `password_hash` não é selecionado por padrão nem serializado.
- Erros de login usam mensagem genérica e usuários `inactive` não autenticam.

## Access token

- JWT assinado com HS256 e segredo obrigatório de pelo menos 32 caracteres.
- Duração padrão: 15 minutos, configurável.
- Claims aceitas: `sub`, `sessionId`, `type: access`, `iat` e `exp`.
- Organização, membership, papel e permissões não entram no JWT.
- O guard consulta o PostgreSQL e exige sessão ativa/não expirada e user ativo.

## Refresh token e sessões

- Refresh token opaco: `sessionId` + segredo aleatório de 32 bytes em base64url.
- O banco armazena somente HMAC-SHA-256 com `REFRESH_TOKEN_PEPPER`.
- O refresh bruto nunca aparece em JSON, body de request, logs, auditoria ou
  erro. Produção usa cookie host-only `__Host-genesis_refresh`, `HttpOnly`,
  `Secure`, `SameSite=Lax` e `Path=/`; desenvolvimento/teste usam nome separado
  e `Secure=false`.
- Cada login cria sessão persistida e token `active`; validade padrão de 30 dias.
- Rotação é transacional e mantém histórico `active`/`consumed`/`revoked`. Uma
  pré-leitura sem lock localiza apenas os IDs pelo par exato sessão/hash; ela
  não decide autorização. A transação adquire locks separados na ordem `User`
  -> `AuthSession` -> `AuthRefreshToken`, relê o estado completo e executa todas
  as validações somente depois dos locks.
- O lock do user usa exclusivamente
  `app_private.lock_auth_refresh_user(uuid)`, sem conceder `UPDATE` em `users` à
  role runtime. A função não retorna dados nem escreve e usa `FOR NO KEY
UPDATE`: inativação, delete e mudança de chave permanecem bloqueados até
  commit/rollback, enquanto inserts de auditoria que dependem de `KEY SHARE`
  continuam livres e não formam ciclo com logout/logout-all.
- Reapresentar um token `consumed` comprova reutilização e revoga sessão e tokens ativos.
- Um segredo aleatório cujo hash nunca existiu retorna `401` e auditoria de falha, sem revogar a sessão indicada pelo identificador público.
- Logout usa refresh identificável, não exige access token, é idempotente e
  sempre limpa refresh/CSRF; logout-all preserva Bearer, revoga todas as sessões
  ativas do user e também limpa cookies.
- Sessões expiradas/revogadas e usuários inativos são rejeitados no access e no refresh.

## CSRF, CORS e cache web

- `GET /auth/csrf` gera 32 bytes aleatórios em base64url, define cookie
  host-only legível pelo frontend e responde `no-store`, sem sessão ou PII.
- Login, refresh, logout e logout-all exigem exatamente um cookie CSRF e
  `X-CSRF-Token` equivalente. A comparação usa `timingSafeEqual`; ausência,
  duplicidade, encoding inválido ou divergência retornam o mesmo `403`.
- Quando `Origin` está presente, deve coincidir byte a byte com `FRONTEND_URL`,
  validada como origem HTTP(S) exata, sem path, barra final ou wildcard.
- CORS habilita credentials somente para essa origem e declara explicitamente
  os headers aceitos/expostos. Não existe allowlist ampla de previews.
- Auth, bootstrap e respostas tenant-scoped usam `Cache-Control: no-store`,
  inclusive falhas processadas pelos guards.

## Auditoria e sanitização

- Eventos são persistidos em `auth_audit_logs` com user/sessão quando conhecidos, IP, user agent e metadata.
- Chaves contendo password, token, secret, hash ou authorization são removidas.
- Strings de metadata são limitadas a 256 caracteres e user agent a 512.
- O filtro global não devolve detalhes de erros internos; health indisponível não expõe o erro do banco.

## Runtime health

- `GET /api/v1/health/live` não consulta PostgreSQL e revela apenas `ok` ou
  `unavailable`.
- `/health`, `/api/v1/health` e `/api/v1/health/ready` compartilham a readiness
  vinculada ao estado do runtime e a `SELECT 1`.
- Respostas usam `Cache-Control: no-store` e não expõem versão, topologia,
  credencial, erro, stack ou causa interna.
- O deadline de readiness é de 1,5 segundo; ele encerra a decisão HTTP, mas não
  cancela fisicamente uma query já enviada.
- Durante shutdown, readiness falha imediatamente, liveness permanece positiva
  em `draining` e torna-se indisponível em `stopped`. Os hooks possuem deadline
  de 12 segundos e saída normal quando concluem.

## Rate limit e proxy

- Há buckets por IP+email normalizado e agregados por IP.
- Defaults: 5 falhas por credencial, 25 por IP, janela de 900 segundos e até 10.000 buckets.
- Buckets expiram, o total é limitado e o limitador falha fechado com `429` ao atingir capacidade.
- A implementação é em memória, por instância e perde estado ao reiniciar.
- `TRUST_PROXY_HOPS` é limitado de 0 a 5; o padrão 0 não confia em `X-Forwarded-For`.
- No modo funcional versionado, a API não usa `request.ip` para rate limit ou
  auditoria. Ela exige a atestação criada pelo Traefik e um único
  `X-Genesis-Client-IP` canônico criado pela Function, redige headers internos e
  forwarded antes dos controllers e guarda o IP aprovado em estado privado da
  request.
- O router funcional exige chave de origem, remove essa chave antes da API e
  sobrescreve a atestação. O Compose base permanece health-only; segredo,
  ativação e exposição pertencem a Gate operacional posterior.

## Segredos, seed e CI

- `.env` é ignorado; `.env.example` contém apenas placeholders e valores descartáveis.
- JWT secret e refresh pepper são independentes, obrigatórios e validados contra placeholders conhecidos.
- `INITIAL_OWNER_PASSWORD` é opcional no runtime e usada somente pelo seed quando falta credencial; não deve permanecer no ambiente, ser logada ou versionada.
- `validate`, `image-impact` e `build-and-scan` têm somente `contents: read`.
  `validate` usa PostgreSQL `_test` descartável e valores sintéticos;
  `image-impact` usa apenas Git e Node.js; nenhum deles autentica ou publica.
- A matriz sintética de produção do job `validate` contém somente configuração
  não secreta. Seus seis secrets sintéticos ficam em arquivos `0600` sob
  `RUNNER_TEMP`, são ligados por override Compose transitório, nunca são
  impressos ou enviados como artifact e têm cleanup explícito com `always()`.
  Os cinco paths são derivados em runtime por um step inicial e exportados via
  `GITHUB_ENV`; expressões `${{ runner.* }}` em `jobs.*.env` são rejeitadas.
  O render falha fechado diante de role repetida, referência mutável, frontend
  divergente, versão de keyring divergente, path ou permissão de secret
  incorretos. Remoção de arquivo ou diretório residual também falha fechado.
- Todo `push` da `main` mantém a validação completa. `image-impact` compara
  `github.event.before` e `github.sha` como commits completos e emite somente o
  booleano canônico `should_publish`; SHA inválido, range irresolúvel, path
  inseguro ou saída Git ambígua falha fechado.
- Somente `publish-image`, condicionado a `push` impactante da `main`, sucesso
  de `validate` e `image-impact` e saída exata `true`, recebe `packages: write`
  e usa `GITHUB_TOKEN` para o GHCR. Não existe PAT ou secret adicional, e
  nenhuma credencial é passada como build arg. Mudanças somente documentais,
  operacionais, de Compose, CI, scripts ou testes param antes de login e build.
- A allowlist image-affecting contém apenas `Dockerfile`, `.dockerignore`,
  `.npmrc` quando rastreado, manifests npm, `nest-cli.json`, `tsconfig.json`,
  demais `tsconfig*.json` legítimos na raiz e `src/**`. Ela deve mudar no mesmo
  delta que introduzir uma nova entrada do build ou do filesystem final, com
  atualização do detector, testes, validator e documentação.
- A imagem `linux/amd64` usa somente tag `sha-<SHA completo>`, seis labels OCI e
  referência remota por digest. Trivy v0.70.0, fixado por Action em SHA completo, bloqueia
  vulnerabilidade Critical inclusive sem correção antes de qualquer push;
  falha da base do scanner também bloqueia.
- Tag existente é validada e reescaneada por digest sem rebuild ou overwrite.
  Tag nova registra o config digest local antes do scan, exige que ele permaneça
  igual no push e aceita o manifesto remoto somente pelo digest reportado pelo
  próprio push. `.Manifest` é tratado exclusivamente como descriptor do manifest
  digest, o manifesto OCI bruto obtido por `--raw` fornece `config.digest` e
  `.Image` fornece plataforma e labels. A imagem remota por digest é reescaneada
  depois da verificação de identidade e do package e antes do artifact.

<!-- genesis-memory-history:start -->

### Snapshot histórico do package GHCR público

- No ciclo histórico da `0.8-MVP-04`, o package GHCR público foi aprovado
  explicitamente. A CI falha fechado se ele
  estiver ausente, não estiver vinculado a `arthurportodev/genesis-platform-api`,
  não for `public`, se a versão selecionada não possuir somente a tag SHA esperada
  ou se existir tag mutável `latest`/`main`. A consulta usa a API oficial com o
  `GITHUB_TOKEN` do job; PAT, scope adicional e mudança de visibilidade são
  proibidos.
- A imagem pública contém somente runtime e artefatos de produção; inspeção e
  scans não encontraram secrets. Publicidade não reduz os controles de
  integridade por SHA completo, digests, labels, scan e permissões mínimas.
  Provenance, SBOM, assinatura, multiarch, SARIF e cache remoto de build estão
  desabilitados ou fora do escopo. A CI não executa seed ou deploy.
- A `0.8-MVP-04-CORR-01` foi concluída integralmente no PR #33 e sua execução
  pós-merge preservou o package público e publicou apenas a tag imutável do
  squash aprovado. A correção de filtro não altera package, tags históricas,
  visibilidade, digests ou permissões do GHCR.

<!-- genesis-memory-history:end -->

- O destino arquitetural aprovado para o MVP é GHCR privado. A implementação
  dessa transição e a visibilidade live não são inferidas do histórico nem
  alteradas por esta correção.
- Testes de integração recusam banco cujo nome não termine em `_test`.
- O contrato da `0.8-MVP-05A`, incorporado pelo PR #35 no squash
  `5268706d22cb69df7d065928c16b4425a03b41cf`, remove secrets do `environment`
  do Compose. Arquivos individuais de host são montados seletivamente por
  Compose secrets; os containers não-root da API e migration recebem apenas o
  GID suplementar 70 modelado. A `0.8-MVP-05B` criou o host layout, grupo e seis
  arquivos reais sob metadata restrita e validou mounts seletivos sem expor
  valores.
- Wrappers POSIX read-only usam paths constantes, falham diante de arquivo
  ausente ou vazio, removem somente um newline terminal, preservam caracteres
  especiais e terminam em `exec`. Eles não imprimem valores. O PostgreSQL usa
  `POSTGRES_PASSWORD_FILE`; `docker inspect Config.Env` contém somente paths e
  configuração não secreta.
- Bootstrap, migration e runtime recebem subconjuntos distintos. A API nunca
  recebe bootstrap/migration; migration nunca recebe bootstrap/runtime/JWT;
  PostgreSQL não recebe JWT, pepper ou keyring de Leads.
- As correções integrantes preservam essa fronteira: `CORR-01` cobre a matriz
  completa, arquivos sintéticos privados e cleanup fail-closed; `CORR-02`
  inicializa paths somente de `RUNNER_TEMP`; `CORR-03` usa fixtures Git
  herméticas, com manifesto próprio, para que testes de bundle não herdem
  estado ignorado do checkout do desenvolvedor.
- Na captura operacional da 05B, o F-001 ocorreu somente no mecanismo fictício
  de validação: o driver encerrava o PTY cedo demais e não conseguia provar a
  restauração do echo. Nenhum secret real foi processado durante as falhas. O
  driver corrigido passou a suíte fictícia final `17/17`; a captura humana sem
  eco pelo Web Terminal foi validada e o finding foi resolvido.
- Os seis secrets reais foram capturados sem passar por chat, argumentos ou
  ferramentas. Na VPS existem somente como arquivos regulares
  `root:genesis-container-secrets` `0440`: cinco valores simples e um keyring
  versionado. A custódia usa Bitwarden Free, export JSON protegido por senha em
  armazenamento offline cifrado fora da VPS, senha do export separada e
  recovery code externo à Bitwarden. Nenhum CSV ou JSON aberto foi produzido.
- O F-002 demonstrou que as credenciais lógicas de migration e runtime podiam
  permanecer no environment do processo PostgreSQL após o init sourced. Nenhum
  valor ou hash foi impresso e os demais scans retornaram zero. O PostgreSQL foi
  contido graciosamente, preservando banco e volume; a correção do PR #37 faz o
  cleanup explícito antes das consultas pós-init, preserva o trap de erro e foi
  aplicada no release corrigido. As duas variáveis estão ausentes no processo
  final, e o finding foi resolvido.
- A CI pós-merge `31286630732` passou com `shouldPublish=false`; o publicador
  ficou ignorado, nenhuma tag nova foi criada e o digest canônico da API
  `sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659`
  permaneceu inalterado.

## Integridade do repositório

- A `main` é protegida por ruleset ativo e alterações entram obrigatoriamente por Pull Request.
- O check `Validate backend and production contracts` deve passar com a branch
  atualizada, e conversas de revisão devem estar resolvidas.
- O histórico deve permanecer linear; force push e exclusão da `main` são bloqueados.
- Não há bypass permanente configurado para usuário, administrador, aplicação ou time.

## Contexto de organização ativa

- Requests tenant-scoped validam organização e membership ativas no PostgreSQL a cada acesso.
- `userId` vem do access token validado; `organizationId`, exclusivamente do header `X-Organization-Id` validado como UUID v4.
- `membershipId` e papel vêm da membership persistida e refletem alterações na request seguinte.
- Organização inexistente/inativa e membership ausente/inativa usam a mesma negação genérica, sem revelar a causa.
- Tenant, membership e papel permanecem fora do JWT, da sessão e do user.
- O contexto não é aceito de body, query ou cookie e não é registrado integralmente em logs.
- Não há cache ou estado compartilhado de tenant; a validação ocorre novamente a cada request tenant-scoped.
- Bootstrap não seleciona tenant: retorna apenas Organizations e memberships
  ativas do user autenticado, com papel persistido e ordem determinística.
- A infraestrutura de tenant context e a autorização genérica por papel protegem as rotas administrativas de invitations, primeira entidade de domínio com `organization_id`.

## Autorização por papel implementada

- A cadeia tenant-scoped implementada executa `AccessTokenGuard`, `TenantContextGuard` e `RoleGuard`, nessa ordem.
- O papel vem somente da membership persistida e chega pelo `TenantContext`; JWT, sessão e entradas do cliente não fornecem papel.
- `@Roles` declara todos os papéis aceitos explicitamente, sem hierarquia implícita.
- Metadata ausente, vazia ou malformada falha com `500`; a validação também rejeita arrays esparsos e índices herdados, evitando política permissiva por erro de configuração.
- Tenant context ausente falha com `500`, pois indica composição incorreta da cadeia.
- Papel insuficiente reutiliza `403 Organization access denied.` sem revelar papel atual, lista permitida, organization, membership ou política.
- O `RoleGuard` não aceita papel de body, query, header, cookie ou `request.user`; não executa consulta adicional, não cria cache e não altera o contexto.
- Permissions, policy engine, autorização por recurso, matriz real de capacidades e proteção do último owner permanecem fora da tarefa 0.2.4.
- As rotas administrativas de invitations são o primeiro consumidor tenant-scoped; a regra de papel também é revalidada no service.
- O papel é um snapshot validado por request. Uma alteração concorrente posterior à criação do contexto será observada na request seguinte; operações críticas futuras poderão exigir revalidação transacional própria.

## Segurança da entrega e acceptance

- Token bearer trafega apenas no body e no fragmento do link; nunca em query,
  logs, audit, outbox ou resposta administrativa.
- Inspect usa resposta uniforme, masking e `no-store`; accept exige access token
  do usuário cujo email normalizado coincide exatamente com o convite.
- Keyring é versionado e completo para o backlog; ausência de chave falha
  fechada sem fallback para a versão corrente nem chamada ao provider.
- Worker usa idempotency key estável, lease/fencing e relógio PostgreSQL. Health
  não consulta Resend e não expõe configuração, PII ou causa interna.
- Create/replace não consultam a existência de User ou Membership do recipient;
  isso evita enumeração e mantém a emissão compatível com usuários novos. Toda
  identidade e estado são derivados e revalidados somente em acceptance.
- Activation pública aceita somente token, nome e senha, usa resposta genérica
  para todos os estados indisponíveis e nunca cria sessão. HMAC é validado antes
  de Argon2 e novamente sob locks; hash, senha, token, MAC e nonce não são logados.
- Argon2 possui capacidade local sem fila e activation possui buckets por IP e
  invitation+IP. Enquanto esses controles forem process-local, readiness e
  issuance exigem exatamente uma réplica pública.
- A função privada de activation recebe somente IDs/contexto tipados, deriva
  email, Organization e papel do banco, proíbe owner, tem `PUBLIC EXECUTE`
  revogado e preserva a role runtime sem INSERT/UPDATE amplo em users/memberships.

## Gestão de memberships e ownership

- Rotas `/api/v1/members` exigem autenticação, tenant ativo e papel explícito;
  owner vê todos os vínculos, admin é hard-filtered para `member` e member só
  pode sair pela rota dedicada.
- Alvos cross-tenant, ausentes ou não visíveis retornam `404` uniforme. Comandos
  de target não aceitam a própria Membership do ator.
- A função `app_private.execute_membership_command` é a única fronteira de
  mutação concedida ao runtime. `PUBLIC EXECUTE`, DML direto nas tabelas
  centrais, `CREATE` no schema e capacidade de assumir o owner são negados.
- A ordem de lock é Organization → Users ordenados → Memberships ordenadas.
  O resultado `blocked_last_owner` é auditado e commitado antes da resposta
  `409`; no-op não cria audit.
- Constraint triggers diferidos preservam ao menos um owner efetivo por
  Organization ativa, inclusive para SQL direto e alterações em Organization,
  User ou Membership. A identidade user/organization da Membership é imutável.
- Readiness confere a allowlist exata de funções executáveis, metadata de
  `SECURITY DEFINER`/`search_path`, ACLs e os triggers novos e legados. Qualquer
  drift fecha as rotas com `503`.
- `API_PUBLIC_REPLICA_COUNT=1` é obrigatório enquanto rate limits forem
  process-local. O nome legado é somente compatibilidade temporária e conflito
  entre ambos falha fechado.

## Baseline obrigatória de produção do MVP

- Toda rota tenant-scoped preserva isolamento entre Organizations; o smoke de
  abertura inclui caso cross-tenant adversarial.
- Autenticação, autorização e papéis `owner`, `admin` e `member` permanecem
  ativos e fail-closed.
- Secrets ficam fora do Git, frontend, imagem e logs; HTTPS protege todos os
  hops públicos.
- Somente o Traefik publica a origem. API e PostgreSQL permanecem em rede
  privada, sem bind público.
- PostgreSQL usa persistência externa, bootstrap superuser separado, migration
  owner sem atributos administrativos, runtime restrito e migrations
  controladas. Os três nomes são distintos, não possuem memberships entre si,
  e privilégios de `PUBLIC` são revogados no database/schema.
- API e PostgreSQL são fixados por digest para `linux/amd64`; tags e fallback
  mutável são rejeitados pelo validator e pelo bundle.
- Bundle `candidate` é explicitamente não operacional e preso à identidade da
  candidata pré-merge. Somente `committed-release`, reconstruído e verificado
  contra paths, blobs e modes de um commit real, pode seguir para uma VPS.
- Os scripts do bundle permanecem `0644`: API/migration são interpretados por
  `/bin/sh`, e o init não executável é lido com `source` pelo entrypoint oficial
  PostgreSQL. Mudança para `0755` ou outro mode falha na proveniência.
- `genesis-postgres-data` é externo: Compose não o cria nem o remove por
  `down -v`. A criação controlada foi executada pela `0.8-MVP-05B`.
- Backup e restore testado, logs sanitizados, health, monitoramento básico e
  rollback são requisitos para dados reais.
- Vulnerabilidade Critical aplicável bloqueia a abertura até correção ou
  decisão humana explícita.
- O destino aprovado usa Hostinger KVM 2, frontend Vercel em
  `app.agenciagenesismkt.com.br`, API em `api.agenciagenesismkt.com.br`,
  Traefik, NestJS em container, PostgreSQL privado, GHCR privado, deploy inicial
  manual, backup externo no Google Drive, UptimeRobot sobre `/health` e somente
  produção inicialmente. Essa decisão não comprova ativação live.
- A imagem final de produção não contém npm, npx, Yarn, Corepack ou seus módulos
  globais. O Node é copiado isoladamente para Alpine 3.24, e o contrato de CI
  inspeciona o filesystem real antes do scan e de qualquer publicação.

<!-- genesis-memory-history:start -->

### Snapshot histórico da baseline privada

Após o merge da 05A, o builder e o validator do bundle aprovaram um
`committed-release` operacional. A `0.8-MVP-05B` reconstruiu e verificou o
release contra o commit
`38baf1e8898194b618cfee787a3bea753677eb93`, com exatamente seis arquivos em
mode `0644`, e instalou a baseline privada na VPS sob autorização operacional
própria. Host, supply chain, secrets, PostgreSQL, API, rede e persistência
pós-reboot passaram por verificação final independente com zero findings e
zero limitations.

A VPS Hostinger KVM 2 hospeda uma réplica privada da API e o PostgreSQL. Seu
inventário, hardening, configuração e adequação ao escopo da 05B foram
comprovados; somente TCP/22 permanece acessível externamente. O frontend na
Vercel preserva o proxy same-origin `/api/v1`; Preview não recebe a origem de
produção. Naquele snapshot, domínios, provedor de backup e ferramenta de
monitoramento ainda não tinham decisão registrada.

<!-- genesis-memory-history:end -->

## Controles avançados adiados

Não são bloqueadores automáticos do primeiro MVP: binder multidomínio
customizado, reconciliação formal de todas as identidades OCI, atomic
output-set avançado, packages reconstruíveis de alta garantia, verificador
independente em toda alteração, equivalência Windows/Linux em todo delta,
banco Grype formalmente selado, SBOM como gate obrigatório, attestations
avançadas, auditoria criptográfica completa, pipeline customizado de supply
chain e deploy totalmente automatizado.

Esses controles não são declarados implementados. Eles pertencem ao backlog de
maturidade e podem ser promovidos conforme adoção, dados, compliance e risco.

## Limitações duráveis

- Implementação e observação de Vercel, DNS, Traefik, backup e monitoramento
  devem ser comprovadas separadamente da decisão arquitetural; o estado
  temporal pertence a `docs/memory/project-state.v1.json`.
- Dados reais exigem backup/restore, monitoramento, smoke cross-tenant e
  autorização humana conforme os release gates da autoridade temporal.
- Não há grace period backend: duas abas que reapresentem o mesmo refresh podem
  acionar reuse detection e revogar a família, conforme a política existente.
- Rate limits e semáforos process-local exigem uma única réplica pública.

## Segurança da fundação de Leads 0.3.1

- Toda leitura usa filtro obrigatório por `organization_id`; member recebe ainda filtro por `responsible_membership_id`, e alvos invisíveis ou cross-tenant usam `404` uniforme.
- O runtime possui somente `SELECT` nas tabelas visíveis de Lead e `EXECUTE` nas três funções estreitas de mutação e na função de inventário de versões; não recebe DML nas tabelas CRM nem acesso direto à idempotência técnica.
- Telefone passa por `libphonenumber-js`, default BR, validação de possibilidade e persistência E.164 antes de fingerprint ou escrita.
- Idempotência usa chave UUID v4 e fingerprint HMAC-SHA-256 canônico com keyring versionado. Reuso com payload divergente retorna conflito.
- O intake `genesis_form` valida HMAC sobre timestamp, idempotency key e hash do corpo bruto, usa comparação constant-time, janela de cinco minutos e rate limits process-local por IP e versão de chave.
- Readiness falha com `503` se keyring, réplica única, schema, funções, triggers ou ACLs não estiverem íntegros. O canal externo permanece desabilitado até a homologação do relay real da Agência Gênesis.
- `If-Match` é obrigatório em updates e assignment: ausente `428`, revisão stale `412` e conflito de telefone ou fingerprint `409`.

## Segurança do lifecycle comercial de Leads 0.3.2

- Todo comando exige `If-Match` e `Idempotency-Key` UUID v4. O fingerprint HMAC cobre tenant, ator, Lead, comando, revisão e payload normalizado; replay revalida ator e visibilidade, retorna `204` e não repete efeitos.
- A função privada bloqueia Organization, User, Membership, Lead, claim, ciclo e revisão em ordem fixa. Revisões stale retornam `412`; chave reutilizada com outro fingerprint ou transição inválida retorna `409`.
- Member pode mover, ganhar e perder somente Lead atualmente atribuído; archive, reactivate e dismiss são owner/admin. Member não altera dados básicos de Lead encerrado, e perde acesso imediatamente após unassign ou offboarding.
- Ciclos e revisões possuem foreign keys tenant-scoped, checks de estado e triggers contra alteração histórica. A consistência Lead↔ciclo é verificada no commit por constraints diferidas.
- Motivos são enums fechados. A nota é trimada, limitada a 500 code points, obrigatória para `other`, rejeita Unicode malformado e qualquer controle, inclusive quebra de linha; não entra em fingerprint persistido em claro, logs ou metadata de idempotência.
- O runtime recebe somente `SELECT` em ciclos/revisões e `EXECUTE` na função de comando; não recebe qualquer acesso direto à tabela de claims nem DML nas tabelas CRM. Readiness compara a allowlist executável exata e falha fechada diante de drift.

## Segurança de Activities e Follow-up 0.3.3

- As seis mutações exigem `If-Match` e `Idempotency-Key` UUID v4. Claims persistem somente HMAC versionado do contrato normalizado; Activity, Note e descrição da Next Action não entram em claro na idempotência, timeline ou logs.
- A função `SECURITY DEFINER` relê Organization, Users, Memberships, Lead, ciclo e pendência sob a ordem global de locks. Owner/admin operam o tenant; member só opera Lead ativo atualmente atribuído e perde capacidade após unassignment ou offboarding.
- Activity e Note são append-only. Next Action aceita somente `pending → completed|canceled`, possui índice único parcial para uma pendência por Lead e gera Activity derivada única na conclusão.
- Timezone é obrigatório e validado contra `pg_timezone_names`. A classificação temporal usa o relógio PostgreSQL e o timezone persistido da Organization, nunca timezone do cliente, processo, sessão ou servidor.
- Timeline autoriza o Lead antes dos joins, pagina por sequência e não duplica textos livres em metadata. Conclusão+Activity, fechamento+cancelamento e assignment/offboarding+transferência aparecem como um único item composto.
- O runtime não recebe DML direto nas novas tabelas nem acesso às claims. Readiness verifica tabelas, colunas, constraints, triggers, funções, ACL e inventário global exato; rollback falha fechado depois do primeiro dado real.

## Segurança das projeções operacionais 0.3.4

- Lista, Kanban, filas, detalhe, ciclos e métricas revalidam no mesmo statement a Organization, o User, a Membership, o vínculo entre eles e o papel atual. Member só alcança Lead cujo responsável atual é sua própria Membership.
- IDs de tenant e ator vêm do contexto autenticado. Filtros de responsável validam target ativo no mesmo tenant; target ausente, inativo ou cross-tenant produz `404` uniforme.
- Busca aceita somente prefixo textual escapado ou telefone completo normalizado por igualdade. Cursores são canônicos, versionados, limitados, autenticados contra sort e filtros e não contêm nome, telefone, email, empresa ou texto de busca.
- Métricas e filas administrativas são owner/admin. Dados livres não entram em métricas, labels, logs ou caches compartilhados; respostas tenant-scoped permanecem `no-store`.
- Readiness dos índices e UTF8 falha com `503` somente nas projeções dependentes. O runtime conserva a ACL existente de `SELECT`, sem função privilegiada, grant ou DML novo.
- Timeout de statement é local à transação. Limites de leitura por Membership, IP confiável e um bucket adicional de métricas são process-local e exigem topologia de uma réplica pública.

- Proxy same-origin local e coordenação de refresh entre abas estão
  implementados no frontend; o proxy de produção pertence ao delta
  `0.8-MVP-08`.
  Tokens continuam proibidos em `localStorage`.
- Rate limiter e semaphore Argon2 não são distribuídos; uma solução compartilhada será necessária antes de múltiplas réplicas públicas.
- Política de retenção/limpeza de sessões, tokens e auditoria não foi definida.
- A estratégia de armazenamento de secrets foi aprovada, mas rotação e
  recuperação operacionais ainda precisam ser implementadas e testadas.
- Outras entidades comerciais tenant-scoped e seus filtros por `organization_id` ainda não foram implementados.
- PostgreSQL RLS com `FORCE` protege a auditoria organizacional append-only;
  RLS geral para as demais tabelas continua uma possibilidade futura.
- Recuperação de senha, confirmação de email, MFA e controles de produção não fazem parte do estágio atual.

## Convites administrativos

- Toda rota usa a cadeia de guards existente e listas explícitas owner/admin.
  Create, replace e revoke relêem user, organization, membership e role dentro
  da transação; list/get são leituras tenant-filtered e revalidam o actor sem
  abrir transação de escrita.
- Admin é hard-filtered para `member`; IDs cross-tenant ou invitations de admin
  usam `404` uniforme.
- Create/replace consultam readiness operacional antes de qualquer transação;
  em produção, a emissão abre somente com todas as precondições explícitas.
- Owner invitation é impossível no DTO, enum do banco e service.
- Token bruto, MAC, chave e nonce nunca entram em API, audit, outbox,
  idempotência ou logs. O nonce é a única matéria do token persistida e não é
  selecionada por padrão.
- Quotas por actor, organização, email e pendentes são verificadas sob lock da
  organização; revoke não consome quota e replay não escreve novamente.
- Triggers cobrem inativação direta de issuer membership/user; simples mudança
  de role não revoga invitations.
- `organization_audit_logs` permite somente `SELECT`/`INSERT` por policy e
  grants explícitos; a verificação efetiva também nega `UPDATE`, `DELETE`,
  `TRUNCATE`, `REFERENCES`, `TRIGGER` e `MAINTAIN`, inclusive por herança, e
  triggers mantêm a defesa contra mutação para o owner.
  Como em qualquer RLS PostgreSQL, superusers e roles com `BYPASSRLS` permanecem
  uma exceção operacional residual e não devem ser usados pelo runtime.
- A role de runtime é preexistente e configurada por `DATABASE_RUNTIME_ROLE`;
  deve ser LOGIN, idêntica a `DATABASE_USER` e distinta do owner de migrations,
  cujas credenciais `DATABASE_MIGRATION_*` não são carregadas pela API. A
  migration não cria role, concede ACL mínima por tabela e falha fechada também
  ao detectar qualquer privilégio efetivo/herdado fora de `SELECT`/`INSERT` na
  auditoria organizacional.
- Create/replace não consultam a existência global do User recipient. Dentro da
  transação, bloqueiam e relêem organization, User ator e membership ator;
  replace também bloqueia e relê a invitation alvo. Tenant, status, papel e
  capability do ator são revalidados, enquanto o email do recipient permanece
  somente como valor normalizado do comando e da invitation.
- O resultado persistido de replace contém somente invitation anterior/nova e
  os snapshots fixos `pending`/`queued`; metadata da resposta/replay permanece
  separada e nunca adiciona campos ao payload público.

## Candidato 0.8-MVP-06A — fronteira de confiança do edge

O edge candidato reduz a superfície pública ao predicado exato
`Host(api.agenciagenesismkt.com.br) && Path(/health) && Method(GET)`. Não há
router catch-all: `/`, `/api/v1`, `/api/v1/health`, `/api/v1/auth/csrf`,
`/dashboard/`, `/api/rawdata`, `POST /health`, outros métodos e outros hosts
falham no Traefik antes de alcançar a API.

O Traefik não recebe Docker socket, capabilities além de
`NET_BIND_SERVICE`, filesystem gravável geral, dashboard/API ou porta 8080.
Forwarded headers inseguros permanecem desabilitados nos entrypoints. A API
confia exatamente um hop; com a cadeia sanitizada pelo Traefik, o endereço mais
próximo é o IP efetivo para rate limit e auditoria, e um endereço forjado à
esquerda não o controla. A topologia direta usa zero hops.

O Compose base tem zero bindings. Cada modo exige `host_ip` explícito, proíbe
IPv6 wildcard e substitui integralmente a lista de portas; API/3000,
PostgreSQL/5432 e Traefik/8080 nunca são publicados. UFW não é evidência de
privacidade de um binding Docker.

ACME usa apenas HTTP-01. Staging e produção têm CAs e arquivos separados; o
email é não secreto, mas é validado e não logado. Os arquivos de estado são
regulares, persistentes, `0600`, externos ao Git e nunca são lidos para gerar
evidência. A configuração de produção não é iniciada localmente e nenhum ACME
live foi executado nesta candidata.

## Recovery boundary 0.8-MVP-07A

Backups lógicos falham se a credencial não provar acesso completo apesar de
RLS. O runtime da API continua `NOBYPASSRLS`; `genesis_backup` é uma role
dedicada `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`,
`BYPASSRLS`, `CONNECTION LIMIT 1`, com membership exclusiva e restrita em
`pg_read_all_data`. Ela deve ter leitura completa, inclusive sob RLS, sem
escrita, ownership, schema create ou membros próprios. Plaintext
existe só como temporário root-only e não recebe hash registrado. Somente o
ciphertext age é transportado e identificado por SHA-256.

OAuth rclone, identidade privada age, pgpass e secrets sintéticos de restore
são referências root-only fora de Git, imagem, bundle, logs e evidências. Drive
usa conta dedicada e lixeira. O preflight aceita somente evidência não secreta
de OAuth externo `In production` para `admreserva433@gmail.com` com scope exato
`drive.file`; rejeita `Testing`, status não comprovável e qualquer token/segredo.
Scope amplo exige novo gate e prova de conta dedicada vazia; purge permanente é
inválido. Restore e cleanup aceitam apenas recursos
isolados rotulados por run, negam o volume ativo e publicam zero portas.
