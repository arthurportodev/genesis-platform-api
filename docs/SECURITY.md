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

## Limitações e decisões abertas

- Refresh token ainda é retornado em JSON; cookie `HttpOnly` não foi implementado.
- Rate limiter não é distribuído; uma solução compartilhada será necessária com múltiplas réplicas.
- Política de retenção/limpeza de sessões, tokens e auditoria não foi definida.
- Rotação operacional de segredos não foi definida.
- Proteção tenant-scoped por `organization_id` ainda não foi implementada.
- PostgreSQL RLS é possibilidade futura, não uma proteção existente.
- Recuperação de senha, confirmação de email, MFA e controles de produção não fazem parte do estágio atual.
