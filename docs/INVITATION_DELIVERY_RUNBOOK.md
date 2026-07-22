# Runbook — entrega e aceitação de convites

## Habilitação segura

1. Aplicar migrations com a role owner e manter a API/worker na role runtime.
2. Configurar todas as versões presentes em convites pending não expirados em `INVITATION_TOKEN_KEYS`.
3. Configurar URL HTTPS sem query/fragment, sender autorizado e chave Resend sending-only.
4. Subir o worker com health interno em `127.0.0.1`; não publicar essa porta.
5. Validar backlog, leases, keyring e acceptance antes de habilitar flags.

Em produção da 0.2.5.2, create/replace continuam bloqueados. Não contornar a readiness.

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
- **Comprometimento de token/key:** desabilitar emissão, revogar convites afetados e rotacionar com nova versão; preservar auditoria.

Logs, métricas, audit e outbox nunca devem conter token, MAC, nonce, link completo, headers, credenciais ou email bruto.
