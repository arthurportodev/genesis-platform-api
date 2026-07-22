# Runbook — entrega, aceitação e ativação de convites

## Habilitação segura

1. Aplicar migrations com a role owner e manter a API/worker na role runtime.
2. Configurar todas as versões presentes em convites pending não expirados em `INVITATION_TOKEN_KEYS`.
3. Configurar URL HTTPS sem query/fragment, sender autorizado e chave Resend sending-only.
4. Manter `API_PUBLIC_REPLICA_COUNT=1`; os rate limits e o semáforo de
   hash são locais ao processo e a ativação falha fechada com qualquer outro
   valor.
5. Subir o worker com `INVITATION_WORKER_ENABLED=true` e health interno em
   `http://127.0.0.1:$INVITATION_WORKER_HEALTH_PORT/health`; não publicar essa
   porta.
6. Confirmar health `200`, loop recente, backlog/leases estáveis, keyring
   completo e migrations aplicadas.
7. Habilitar `INVITATION_ACCEPTANCE_READINESS=true` e
   `INVITATION_ACTIVATION_READINESS=true`; validar inspect, accept para user
   existente e activate para user novo.
8. Somente depois habilitar `INVITATION_ISSUANCE_READINESS=true`. Em produção,
   create/replace continuam fail-closed se acceptance, activation, worker,
   provider, keyring ou réplica única não estiverem prontos.

Não contornar readiness nem habilitar emissão enquanto o health do worker
estiver `503`.

## Rotação e recuperação de chave

- Adicionar a nova versão antes de torná-la corrente.
- Reter versões antigas enquanto houver invitation pending não expirada ou delivery processável.
- `key_version_unavailable` mantém a delivery queued até o deadline de 23 horas; restaurar a chave recupera o mesmo payload e idempotency key.
- Nunca substituir uma chave sob a mesma versão.

## Operação do worker

- Health `200` exige loop recente, banco runtime, configuração e keyring completos; `503` não consulta o provider.
- Outcomes allowlisted: `sent`, `retry_scheduled`, `dead`, `cancelled`, `fenced_out`, `recovered`, `idle`.
- Monitorar claims, retries, dead, cancelled, fenced/recovered, timeout/429/5xx, backlog devido, idade do mais antigo e leases ativas/expiradas.
- Em shutdown, conceder ao menos 20 segundos; lease expirada será recuperada com novo fencing token.

## Incidentes

- **Provider indisponível:** pausar worker se necessário; acceptance continua operante.
- **Chave ausente:** restaurar a versão correta; não promover a current como fallback.
- **Backlog crescente:** verificar DB, health, leases, 429/5xx e sender/API key.
- **Ativação em `503`:** verificar migration/coluna/função, ACL exata da role
  runtime, versões do keyring e `API_PUBLIC_REPLICA_COUNT=1`.
- **Ativação em `429`:** observar separadamente limites por IP, invitation+IP e
  capacidade de hash; não aumentar concorrência sem medir CPU e latência.
- **Comprometimento de token/key:** desabilitar emissão, revogar convites afetados e rotacionar com nova versão; preservar auditoria.

Logs, métricas, audit e outbox nunca devem conter token, MAC, nonce, link completo, headers, credenciais ou email bruto.
