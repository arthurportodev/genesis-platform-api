# Modelo de domínio atual

Este documento resume conceitos implementados; as migrations são a fonte do schema exato.

## User

- **Propósito:** representar uma pessoa globalmente, independentemente de organização.
- **Identidade:** UUID gerado pelo PostgreSQL.
- **Campos principais:** email, nome, status, hash/data de alteração da senha e timestamps.
- **Relações:** possui memberships e sessões de autenticação.
- **Status:** `active` ou `inactive`.
- **Constraints:** email globalmente único, normalizado; nome não vazio e sem bordas.
- **Sensível:** `password_hash`, excluído da serialização e da seleção padrão.
- **Escopo:** global; não contém `organization_id` nem papel.

## Organization

- **Propósito:** representar uma empresa/tenant.
- **Identidade:** UUID gerado pelo PostgreSQL.
- **Campos principais:** nome, slug, status e timestamps.
- **Relações:** possui memberships.
- **Status:** `active` ou `inactive`.
- **Constraints:** slug globalmente único em formato minúsculo adequado para URL; nome válido.
- **Escopo:** raiz do tenant, selecionada por request pela infraestrutura implementada.
- **Criação self-service:** um User global ativo e com email verificado cria uma
  Organization ativa e sua Membership `owner` ativa em uma única transação. O
  trigger canônico também cria o Pipeline default com cinco Stages; o cadastro
  do User continua separado e não cria Organization automaticamente.

## OrganizationCreationIdempotency

- **Propósito:** tornar a criação self-service reiniciável e segura sob retry.
- **Identidade lógica:** par imutável de User ator e `Idempotency-Key` UUID v4.
- **Fingerprint:** SHA-256 da versão do contrato e do nome NFC canônico.
- **Resultado:** snapshot mínimo de Organization e Membership `owner`; replay
  com o mesmo fingerprint retorna os mesmos IDs, enquanto payload divergente é
  conflito e não cria efeitos adicionais.
- **Escopo:** global por User; não seleciona tenant e não aceita
  `X-Organization-Id`.

## Membership

- **Propósito:** vincular `User` e `Organization`.
- **Identidade:** UUID gerado pelo PostgreSQL.
- **Campos principais:** `user_id`, `organization_id`, papel, status e timestamps.
- **Relações:** pertence obrigatoriamente a um user e uma organization.
- **Papéis:** `owner`, `admin`, `member`.
- **Status:** `active` ou `inactive`.
- **Constraints:** par user/organization único; foreign keys usam `ON DELETE RESTRICT`.
- **Ownership:** o papel pertence à membership, nunca diretamente ao user.
- **Identidade do vínculo:** `user_id` e `organization_id` são imutáveis; uma
  mudança de vínculo exige outra Membership.
- **Transições administrativas:** `member` ↔ `admin`, promoção para `owner`,
  demotion de `owner` para `member`/`admin`, `active` ↔ `inactive` e saída
  própria (`active` → `inactive`). Hard delete não faz parte do domínio.
- **Owner efetivo:** exige Organization, User e Membership `active`, além do
  papel `owner`. Toda Organization ativa conserva pelo menos um owner efetivo.
- **Concorrência:** comandos serializam por Organization, depois Users e
  Memberships em UUID crescente; constraint triggers diferidos protegem o
  mesmo invariante contra SQL direto.

## AuthSession

- **Propósito:** controlar uma sessão autenticada e permitir revogação imediata.
- **Identidade:** UUID, também referenciado no access token e no prefixo do refresh token.
- **Campos principais:** user, status, expiração, último uso, revogação/motivo, IP, user agent e timestamps.
- **Relações:** pertence a um user e possui histórico de refresh tokens.
- **Status:** `active` ou `revoked`.
- **Constraints:** estado e `revoked_at` devem ser coerentes; user usa `ON DELETE RESTRICT`.
- **Escopo:** pertence ao user, não a uma organização.

## AuthRefreshToken

- **Propósito:** registrar cada token de uma família e sua rotação.
- **Identidade:** UUID; o token bruto não é persistido.
- **Campos principais:** sessão, HMAC do token, status, validade, consumo, revogação e substituto.
- **Relações:** pertence a uma sessão e pode apontar para o token substituto.
- **Status:** `active`, `consumed` ou `revoked`.
- **Constraints:** hash hexadecimal único de 64 caracteres, estado temporal coerente e substituto único.
- **Sensível:** `token_hash`, excluído da serialização e da seleção padrão.

## AuthAuditLog

- **Propósito:** manter trilha persistente de eventos de autenticação.
- **Identidade:** UUID.
- **Campos principais:** user/sessão opcionais, tipo de evento, IP, user agent, metadata sanitizada e criação.
- **Eventos:** login/refresh bem-sucedidos ou falhos, reutilização, logout e logout-all.
- **Relações:** referências opcionais usam `ON DELETE SET NULL` no schema.
- **Sensível:** metadata é sanitizada e excluída da serialização padrão.

## TenantContext

- **Propósito:** representar, durante uma única request, o acesso validado do user a uma organização ativa.
- **Natureza:** conceito implementado e tipado de request; não é entidade, tabela ou estado persistido.
- **Campos:** `userId`, `organizationId`, `membershipId` e `role`.
- **Origem:** user autenticado, header UUID v4 validado e membership atual consultada no PostgreSQL.
- **Ciclo de vida:** criado pelo `TenantContextGuard` para cada request tenant-scoped e acessado por `CurrentTenant`.
- **Autorização:** o `RoleGuard` implementado consome `role` exclusivamente deste contexto e compara com listas explícitas declaradas por `@Roles`, sem consultar o banco novamente ou modificar o contexto.
- **Limite:** não é armazenado em JWT, sessão ou user; não representa permissions, hierarquia de papéis ou autorização por recurso.

## OrganizationInvitation

- **Propósito:** representar um convite tenant-scoped para `member` ou `admin`.
- **Estados persistidos:** `pending`, `accepted`, `revoked`; `expired` é derivado
  de `expires_at` com precedência accepted → revoked → expired → pending.
- **Token:** nonce não selecionado por padrão e versões são persistidos; token,
  MAC e hash não são persistidos. A MAC HMAC-SHA-256 é regenerável por keyring.
- **Lifecycle:** a 0.2.5.1 implementou create, revoke idempotente e replace com
  nova linha e relação imutável; a 0.2.5.2 implementou aceitação autenticada
  para usuário existente e a 0.2.5.3 adiciona activation para usuário inexistente.
- **Emissor:** membership imutável. Inativar issuer membership/user revoga
  pendentes na mesma transação; mudar role não revoga.

## InvitationDeliveryOutbox e OrganizationAuditLog

O outbox contém somente colunas explícitas e referências, sem token/email/link;
a 0.2.5.2 adicionou worker, retry, fencing e dead-letter sobre os
estados persistidos. A auditoria organizacional é append-only no PostgreSQL e
não reutiliza `AuthAuditLog`.

## Acceptance 0.2.5.2

Uma invitation pending e não expirada pode ser inspecionada pelo bearer e
aceita somente pelo usuário autenticado de email correspondente. O resultado é
atômico: invitation `accepted`, membership criada/preservada/reativada, outbox
cancelável cancelada e um audit append-only. Replay do mesmo usuário devolve os
mesmos IDs sem novos efeitos; membership ativa com papel divergente é conflito.

## Activation 0.2.5.3

Uma invitation pending, não expirada e sem User global para o email pode criar
um User ativo, credencial Argon2id e Membership ativa. Email, Organization e
papel são derivados somente da invitation; `owner` é impossível. O mesmo
timestamp transacional confirma email e mudança de senha. User existente ou uma
corrida na unicidade global não é alterado: toda a activation reverte e o fluxo
autenticado de acceptance continua separado.

## Gestão de memberships e ownership 0.2.5.4

Owner lista e consulta todas as Memberships do tenant e administra qualquer
alvo exceto a própria Membership. Admin lista, consulta, desativa e reativa
somente `member`. `member` não possui diretório e pode apenas sair pela rota
dedicada. Alvos invisíveis ou cross-tenant usam `404` uniforme.

Comandos tipados retornam `changed`, `no_change` ou `blocked_last_owner`.
Mudança efetiva registra exatamente um evento append-only; no-op não registra;
bloqueio do último owner registra a tentativa e preserva o estado. Audit contém
somente `target_membership_id`, ação e snapshots coerentes de role/status, sem
um segundo target user.

## Regra para entidades futuras

Entidades de negócio tenant-scoped devem conter `organization_id` e depender do contexto validado. `OrganizationInvitation` e suas rotas administrativas são a primeira aplicação dessa regra; uma matriz geral de capacidades e as demais entidades de negócio ainda não existem.

## Lead, LeadEntry e Timeline 0.3.1

- `Lead` representa a identidade do contato por `organization_id` e telefone E.164; a unicidade `(organization_id, primary_phone)` é a fronteira de deduplicação.
- `LeadEntry` é append-only e registra cada entrada com canal, Source e UTMs sem sobrescrever atribuição anterior. Toda duplicidade cria exatamente uma nova Entry.
- A timeline append-only registra criação, entrada recebida, alteração de dados básicos e mudança ou limpeza de responsável em colunas explícitas.
- Member enxerga somente Leads atribuídos à sua Membership. Owner/admin acessam o tenant inteiro e administram assignment; offboarding limpa assignments atomicamente, sem redistribuição.

## Pipeline, ciclos e retornos 0.3.2

- `Lead.status` usa `active`, `won`, `lost` ou `archived`. `Lead.stage` e o enum de cinco valores permanecem como ponte temporária para clientes legados; `PipelineStage.id` é a identidade autoritativa da posição atual.
- Cada Organization possui exatamente um `Pipeline` default. O catálogo inicial contém Novo, Qualificação, Diagnóstico, Proposta e Negociação, provisionados transacionalmente também para novas Organizations.
- `Pipeline` e `PipelineStage` são tenant-scoped. Pipeline tem nome e revisão; Stage tem UUID imutável, nome editável, posição inteira positiva e archive sem delete. Nome e posição ativos são únicos dentro do escopo correspondente.
- `Lead` mantém snapshots nullable de Pipeline e Stage para leitura operacional. Um Lead `active` pode ter zero ou um ciclo aberto; sem ciclo os snapshots são nulos, e com ciclo coincidem com a associação corrente do ciclo. Leads terminais não conservam snapshot corrente.
- `LeadCommercialCycle` mantém o histórico imutável de abertura e fechamento, sua associação ao Pipeline e snapshots de nome do Stage na abertura e no fechamento. Renames posteriores não reescrevem esses snapshots.
- O início explícito de ciclo usa o primeiro Stage ativo do Pipeline escolhido. Em Lead já ativo sem ciclo registra `lead.cycle.started`; em Lead terminal registra `lead.reactivated`. Processos em Pipelines diferentes são sequenciais e usam ciclos diferentes.
- Movimentações entre Stages são livres dentro do Pipeline do ciclo aberto. Fechamento preserva o Stage factual e limpa o snapshot corrente do Lead.
- Perda exige um motivo tipado; arquivamento usa motivos próprios. `reasonNote` pertence ao ciclo encerrado, é obrigatório somente para `other`, tem no máximo 500 caracteres e não admite controles ou quebras de linha.
- Uma Entry recebida após fechamento preserva status, estágio e assignment e abre ou agrega um único `LeadReturnReview` pendente. Reativar terminaliza a revisão e abre novo ciclo; descartar apenas terminaliza a revisão.
- Comandos de lifecycle são idempotentes por tenant, ator, comando e UUID v4, usam fingerprint HMAC versionado e controle otimista por revisão. Efeitos efetivos incrementam revisão e timeline exatamente uma vez; mover para o mesmo estágio é no-op persistido.
- A criação manual legada sem contrato continua escolhendo o Pipeline default. Com `X-Genesis-Lead-Contract: pipeline-v2`, `pipelineId` ausente ou nulo cria Lead sem ciclo, enquanto um UUID abre o ciclo no primeiro Stage do Pipeline escolhido. Expected Value continua pertencendo exclusivamente ao ciclo.
- Configuração de Pipeline e Stage é restrita a owner/admin. O Pipeline default nasce com os cinco Stages canônicos da ponte legada e depois admite create, rename, reorder e archive sob as mesmas regras dos Pipelines customizados. Archive bloqueia o último Stage ativo e qualquer Stage ocupado por ciclo aberto; não existe archive de Pipeline no MVP.
- Leituras que admitem Lead sem ciclo exigem o opt-in `X-Genesis-Lead-Contract: pipeline-v2`. Sem esse opt-in, coleções legadas omitem Lead-only e detail/timeline/cycles o tratam como não visível, evitando publicar `latestCycle` nullable para o Web ainda ativo.
- Owner/admin podem editar dados básicos e assignment de Leads encerrados; member pode lê-los enquanto atribuído, mas não editar dados básicos após o fechamento. Offboarding continua limpando assignment sem alterar lifecycle.

## Activities, Notes e Next Action 0.3.3

- `LeadActivity` registra interação humana concluída, pertence a Lead e Commercial Cycle e é append-only. Pode ser direta ou derivada da conclusão de uma Next Action; o vínculo derivado é único.
- `LeadNote` registra conteúdo manual append-only no ciclo. Textos normalizam CRLF para LF, têm limites por code point e não são copiados para timeline, logs, fingerprints ou claims de idempotência.
- `LeadNextAction` representa o único compromisso `pending` do Lead e transita somente para `completed` ou `canceled`. Reagendamento muda apenas `dueAt`; mudar tipo ou descrição exige cancelar e criar outra.
- `dueAt` é um instante `timestamptz`. A leitura dedicada projeta o instante no `crm_time_zone` IANA da Organization e deriva `overdue`, `today`, `future` ou `none` com o relógio PostgreSQL; o estado não é persistido.
- Assignment transfere o snapshot de responsável da pendência. Unassignment e offboarding preservam a pendência com responsável nulo. Fechamento cancela com `lead_closed`, e reativação não restaura a ação.
- Owner/admin podem adicionar Activity retroativa e Note administrativa no último ciclo encerrado. Member só muta Lead ativo atualmente atribuído à própria Membership ativa.
- Timeline pagina por `sequence ASC`, mantém referências tipadas e resolve conteúdo livre nas tabelas canônicas somente após autorizar o Lead.
