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
- Rotação é transacional, bloqueia o registro e mantém histórico `active`/`consumed`/`revoked`.
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
- A infraestrutura de tenant context e a autorização genérica por papel estão implementadas, mas ainda não há entidades comerciais com `organization_id` ou endpoint tenant-scoped de produção.

## Autorização por papel implementada

- A cadeia tenant-scoped implementada executa `AccessTokenGuard`, `TenantContextGuard` e `RoleGuard`, nessa ordem.
- O papel vem somente da membership persistida e chega pelo `TenantContext`; JWT, sessão e entradas do cliente não fornecem papel.
- `@Roles` declara todos os papéis aceitos explicitamente, sem hierarquia implícita.
- Metadata ausente, vazia ou malformada falha com `500`; a validação também rejeita arrays esparsos e índices herdados, evitando política permissiva por erro de configuração.
- Tenant context ausente falha com `500`, pois indica composição incorreta da cadeia.
- Papel insuficiente reutiliza `403 Organization access denied.` sem revelar papel atual, lista permitida, organization, membership ou política.
- O `RoleGuard` não aceita papel de body, query, header, cookie ou `request.user`; não executa consulta adicional, não cria cache e não altera o contexto.
- Permissions, policy engine, autorização por recurso, matriz real de capacidades e proteção do último owner permanecem fora da tarefa 0.2.4.
- Não há endpoint tenant-scoped de produção.
- O papel é um snapshot validado por request. Uma alteração concorrente posterior à criação do contexto será observada na request seguinte; operações críticas futuras poderão exigir revalidação transacional própria.

## Limitações e decisões abertas

- Refresh token ainda é retornado em JSON; cookie `HttpOnly` não foi implementado.
- Rate limiter não é distribuído; uma solução compartilhada será necessária com múltiplas réplicas.
- Política de retenção/limpeza de sessões, tokens e auditoria não foi definida.
- Rotação operacional de segredos não foi definida.
- Entidades comerciais tenant-scoped e seus filtros por `organization_id` ainda não foram implementados.
- PostgreSQL RLS é possibilidade futura, não uma proteção existente.
- Recuperação de senha, confirmação de email, MFA e controles de produção não fazem parte do estágio atual.
