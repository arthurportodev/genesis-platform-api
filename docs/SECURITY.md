# Segurança

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
- Logout revoga a sessão atual; logout-all revoga todas as sessões ativas do user.
- Sessões expiradas/revogadas e usuários inativos são rejeitados no access e no refresh.

## Auditoria e sanitização

- Eventos são persistidos em `auth_audit_logs` com user/sessão quando conhecidos, IP, user agent e metadata.
- Chaves contendo password, token, secret, hash ou authorization são removidas.
- Strings de metadata são limitadas a 256 caracteres e user agent a 512.
- O filtro global não devolve detalhes de erros internos; health indisponível não expõe o erro do banco.

## Rate limit e proxy

- Há buckets por IP+email normalizado e agregados por IP.
- Defaults: 5 falhas por credencial, 25 por IP, janela de 900 segundos e até 10.000 buckets.
- Buckets expiram, o total é limitado e o limitador falha fechado com `429` ao atingir capacidade.
- A implementação é em memória, por instância e perde estado ao reiniciar.
- `TRUST_PROXY_HOPS` é limitado de 0 a 5; o padrão 0 não confia em `X-Forwarded-For`.

## Segredos, seed e CI

- `.env` é ignorado; `.env.example` contém apenas placeholders e valores descartáveis.
- JWT secret e refresh pepper são independentes, obrigatórios e validados contra placeholders conhecidos.
- `INITIAL_OWNER_PASSWORD` é opcional no runtime e usada somente pelo seed quando falta credencial; não deve permanecer no ambiente, ser logada ou versionada.
- O CI tem apenas `contents: read`, usa PostgreSQL `_test` descartável e credenciais `test-only`; não executa seed, deploy ou publicação de imagem.
- Testes de integração recusam banco cujo nome não termine em `_test`.

## Integridade do repositório

- A `main` é protegida por ruleset ativo e alterações entram obrigatoriamente por Pull Request.
- O check `Validate backend` deve passar com a branch atualizada, e conversas de revisão devem estar resolvidas.
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

## Limitações e decisões abertas

- Refresh token ainda é retornado em JSON; cookie `HttpOnly` não foi implementado.
- Rate limiter e semaphore Argon2 não são distribuídos; uma solução compartilhada será necessária antes de múltiplas réplicas públicas.
- Política de retenção/limpeza de sessões, tokens e auditoria não foi definida.
- Rotação operacional de segredos não foi definida.
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
