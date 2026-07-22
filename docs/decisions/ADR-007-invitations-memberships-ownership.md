# ADR-007 — Convites, memberships e invariantes de ownership

- **Status:** Accepted — convites, entrega, aceitação, ativação de usuário novo
  e gestão de memberships/ownership implementados
- **Data:** 2026-07-20

## Contexto

A plataforma precisa permitir entrada por convite, administração de membros e
proteção de ownership sem colocar tenant ou papel no JWT. O fluxo altera schema,
credenciais futuras, autorização tenant-scoped e invariantes concorrentes, por
isso a Tarefa 0.2.5 é Critical e foi dividida em quatro subtarefas Critical.

## Decisão

- Implementar sequencialmente: 0.2.5.1 domínio/administração de convites;
  0.2.5.2 entrega por email e aceitação para user existente; 0.2.5.3 ativação
  de user novo; 0.2.5.4 gestão de memberships e ownership. Cada subtarefa possui
  builder único, verifier, Gates próprios e um Pull Request.
- Permitir múltiplos owners, sem owner principal. Uma organização ativa deverá
  manter ao menos um owner efetivamente ativo.
- Owner convida `member` ou `admin`; admin convida e administra somente
  invitations/memberships de `member`; convite direto para owner é proibido.
- Users existentes e novos serão suportados. Membership inativa será reativada
  na mesma linha com o papel do novo convite. `email_verified_at` pertence à
  0.2.5.3 e não haverá auto-login.
- Entregar tokens exclusivamente por email através de porta e outbox. Token
  bruto nunca é persistido nem devolvido pela API. Provider/worker pertencem à
  0.2.5.2; emissão permanece desabilitada até então.
- A entrega seleciona Resend como provider concreto. O worker reconstrói o token
  somente em memória, usa chave persistida por versão, idempotency key estável,
  leases/fencing e relógio do PostgreSQL. A acceptance permanece independente
  da disponibilidade do provider.
- A ativação de usuário novo recebe somente token, nome e senha, revalida o
  HMAC antes e depois dos locks, deriva organization/email/role da invitation e
  cria User, credencial, Membership, terminalização, cancelamento de outbox e
  audit em uma única função `SECURITY DEFINER`. Não cria sessão nem permite
  owner. IP e user-agent são contexto opcional; por isso essa assinatura é
  `CALLED ON NULL INPUT`, com validação explícita dos argumentos obrigatórios.
- Convites valem sete dias. Expiração é derivada. Replace cria nova invitation,
  revoga e relaciona a anterior. Revoke é idempotente.
- Inativar a membership ou o user emissor revoga na mesma transação suas
  invitations pendentes; mudança simples de papel não revoga.
- Membership removida significa `inactive`; hard delete fica fora.
- `member` não possui diretório de membros.
- Eventos de organização usam auditoria append-only separada de
  `auth_audit_logs`.
- Preservar locks pessimistas sobre `organizations`, `users` e `memberships`
  sem conceder `UPDATE` à role runtime. O PostgreSQL exige `UPDATE` para um
  `SELECT ... FOR UPDATE` direto; portanto a 0.2.5.1 introduz a fronteira
  interna `app_private.lock_invitation_context(uuid[], uuid[], uuid[])`.
  A função é específica para invitations, não retorna dados e apenas adquire
  row locks em organizations, users e memberships, nessa ordem, com UUIDs
  deduplicados e ordenados.
- Preservar também a serialização do refresh com a inativação global sem
  conceder `UPDATE` em `users`. A assinatura separada e exclusiva desse fluxo é
  `app_private.lock_auth_refresh_user(uuid)`, com `FOR NO KEY UPDATE`. A função
  de invitations não é generalizada nem perde seus locks `FOR UPDATE`.

## Fronteira interna de locks

`app_private` pertence ao owner de migrations. `PUBLIC` não recebe `CREATE`
nem `EXECUTE`; a role runtime recebe somente `USAGE` no schema e `EXECUTE` na
assinatura aprovada. Ela não é owner, não pode assumir o owner, criar objetos,
alterar a função nem obter `UPDATE`, inclusive por coluna, nas tabelas centrais.

A função é `SECURITY DEFINER`, `STRICT`, `VOLATILE` e `PARALLEL UNSAFE`, com
`search_path` fixo em `pg_catalog, app_private, pg_temp`. Todas as tabelas são
referenciadas como `public.*`, funções auxiliares como `pg_catalog.*`, e não há
SQL dinâmico, identificador controlado pelo chamador ou escrita. Arrays vazios
são seguros e valores `NULL` internos são rejeitados.

O serviço chama a função com o mesmo `EntityManager` e dentro da mesma
transação da mutação. Em seguida relê as linhas por `SELECT` normal e revalida
tenant, actor, status, papel e capability. Ausência de linha não é tratada pela
função como autorização e o retorno `void` não distingue IDs existentes,
ausentes ou cross-tenant.

A assinatura de autenticação recebe um único user UUID, não retorna dados e
aplica o mesmo hardening. `FOR NO KEY UPDATE` bloqueia inativação, delete e
mudança da chave até commit/rollback, mas permite `KEY SHARE`; isso evita que o
insert de `auth_audit_logs`, após o lock de sessão do logout/logout-all, feche o
ciclo `User` -> `AuthSession` / `AuthSession` -> `User`. O refresh mantém a ordem
`User` -> `AuthSession` -> `AuthRefreshToken` e usa exclusivamente o estado
relido depois dos três locks.

## Token de convite

O token regenerável usa HMAC-SHA-256 com chave exclusiva e versionada. A MAC
assina campos canônicos e length-prefixed: domínio/versão, invitation UUID,
key/token versions, organization UUID, email normalizado, papel, expiração Unix
em milissegundos e nonce de 32 bytes. O formato bruto é
`invitationId.keyVersion.tokenVersion.macBase64url`. O banco guarda nonce e
versões, nunca token, MAC ou hash do token. O outbox guarda somente referências.

## Consequências

- O domínio registra rotas, schema, audit e eventos queued. A entrega substitui
  o bloqueio estático por verificação operacional e implementa provider,
  worker/retry e aceitação para user existente.
- A ativação de user novo é fail-closed por readiness de schema, ACL, keyring e
  réplica pública única; não há auto-login.
- A aceitação deriva organization/email/role exclusivamente da
  invitation; não recebe tenant ou privilégio do cliente.
- Escritas críticas relêem actor, organization e membership dentro da
  transação, pois `RoleGuard` representa um snapshot por request.
- Triggers PostgreSQL preservam D7 também para SQL direto; a porta transacional
  é o caminho normal da aplicação.
- A fronteira privilegiada reduz a superfície de escrita do runtime, mas pode
  ser usada por chamadas autorizadas para manter locks até o fim da transação.
  Timeouts transacionais, ordem determinística e quotas existentes limitam o
  risco residual de contenção/negação de serviço; a função não substitui
  autorização de produto.

## Alternativas consideradas

- Uma única tarefa/PR: rejeitada pelo acoplamento entre schema, email,
  credenciais, API pública e ownership.
- MVP apenas para users existentes: rejeitado como fluxo incompleto porque não
  existe cadastro público.
- Token bruto em banco/outbox ou response: rejeitado por ampliar o impacto de
  vazamento.
- Convite para owner e hierarquia implícita: rejeitados por escalada de
  privilégio.
- Reutilizar `AuthAuditLog`: rejeitado porque eventos de organização não são
  eventos de autenticação.
- Hard delete de membership: rejeitado por histórico e pela unicidade existente.
- Conceder `UPDATE` direto, herdado ou em coluna artificial ao runtime:
  rejeitado por romper least privilege e criar capacidade real de escrita.
- Trocar o protocolo por advisory locks ou remover os locks pessimistas:
  rejeitado porque os mutadores e triggers existentes coordenam por row locks.
- Transformar a função em API genérica, aceitar SQL/identificadores ou retornar
  linhas: rejeitado por ampliar a fronteira privilegiada e permitir enumeração.

## Relações

- [ADR-002 — Estratégia multi-tenant](ADR-002-multi-tenant-strategy.md)
- [ADR-003 — Autenticação e sessões](ADR-003-authentication-sessions.md)
- [ADR-004 — Contexto de organização ativa](ADR-004-active-organization-context.md)
- [ADR-005 — Autorização por papel](ADR-005-role-based-authorization.md)
- [ADR-006 — Modelo operacional multiagente](ADR-006-multi-agent-operating-model.md)

## Implementação

A fundação implementa domínio, administração tenant-scoped, quotas,
idempotência, base persistida do outbox, auditoria, defesas D7 e a API interna
de locks least-privilege. Testes PostgreSQL reais verificam metadata/hardening,
ownership, grants e revokes, ausência de `UPDATE`, bloqueio até commit/rollback,
ordem e deduplicação concorrentes, `search_path` hostil, IDs ausentes e a
rejeição de mutação da fronteira pelo runtime. A entrega e aceitação adicionam
outbox, worker e a mutação atômica para user existente. A ativação adiciona
`email_verified_at`, a política central de credenciais, a assinatura exclusiva
`app_private.activate_new_user_invitation(uuid,text,text,uuid,inet,text)` e
readiness que confirma o conjunto exato de EXECUTE, revogação de PUBLIC,
ausência de DML direto/herdado e impossibilidade de assumir o owner.

Testes PostgreSQL reais cobrem chamadas diretas sob `search_path` hostil,
rollback em cada estágio, corrida de email e activate concorrente com
activate/accept/revoke/replace/inativação de organização. A gestão de
memberships adiciona a função tipada `execute_membership_command`, invariantes
de owner efetivo com constraint triggers diferidos, auditoria coerente e API
tenant-scoped. A emenda de refresh adiciona a
assinatura exclusiva do refresh. Testes reais
distinguem estruturalmente as forças das duas funções, confirmam `KEY SHARE` por
insert de audit, bloqueio de inativação/delete/mudança de chave, rollback e
corridas repetidas refresh×refresh/logout/logout-all sem SQLSTATE `40P01`.
