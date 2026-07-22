# Runbook de memberships e ownership

## Invariante operacional

Toda organização `active` deve conservar ao menos um owner efetivo: organização,
User e Membership `active`, com papel `owner`. A proteção existe na função de
comando e em constraint triggers diferidos para SQL direto. Criação ou
reativação de organização ativa e alterações correlatas devem ocorrer em uma
única transação que termine com owner efetivo.

## Deploy e readiness

1. Executar a pré-auditoria da migration com credenciais de migration owner.
2. Corrigir organizações órfãs antes de repetir a migration; o erro informa
   somente código e contagem.
3. Manter `DATABASE_USER` igual a `DATABASE_RUNTIME_ROLE`, sem superuser,
   `BYPASSRLS`, herança do owner, DML direto nas tabelas centrais ou `CREATE` em
   `app_private`.
4. Configurar `API_PUBLIC_REPLICA_COUNT=1` enquanto rate limits forem locais.
5. Confirmar readiness antes de liberar tráfego. Drift de ACL, funções ou
   triggers fecha as rotas com `503`.

## Diagnóstico de último owner

Um comando bloqueado retorna `409 Organization must retain an active owner.` e
grava `organization.membership.last_owner_change_blocked`. Verifique, para o
tenant, organização, User e Membership do owner; qualquer status inativo remove
o owner da contagem efetiva.

Não desabilite triggers e não conceda DML direto ao runtime para contornar o
bloqueio. Promova ou reative outro owner por uma operação autorizada antes de
repetir demotion, deactivate ou leave.

Antes de confirmar demotion ou deactivate de um owner efetivo, a substituição
deve já existir e ser efetiva na mesma organização: Organization, User e
Membership `active`, com papel `owner`. Não considere uma promoção ainda não
confirmada em outra transação como substituição válida.

## Break-glass e remediação

Break-glass é uma operação manual da role de migration owner, sob mudança
aprovada por duas pessoas autorizadas e auditada. Bloqueie a organização, Users e Memberships em ordem
determinística; reative ou promova uma Membership existente do mesmo tenant;
registre `organization.ownership.remediated` com snapshots coerentes; e faça
commit somente se a consulta de owner efetivo retornar pelo menos uma linha.

Preserve integralmente o histórico: nunca execute hard delete de Membership,
reescrita ou exclusão de auditoria, nem ajuste retroativo de snapshots. A
remediação é sempre append-only e deve manter os identificadores originais.

Depois da remediação, valide readiness, revise eventos de bloqueio/remediação e
revogue imediatamente qualquer acesso temporário. Rollback da migration falha
fechado quando já existem eventos de membership; nesse caso use forward-fix.
