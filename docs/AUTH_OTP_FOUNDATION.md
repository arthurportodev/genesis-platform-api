# AUTH-V2-01 — Fundação de challenges de e-mail

Fundação interna, API-only, sem controller. `AuthEmailChallengesModule` exporta
`AuthEmailChallengesService`; o chamador escolhe os métodos específicos
`issueEmailVerification`, `consumeEmailVerification`, `issuePasswordReset` e
`consumePasswordReset`. Recebem User/challenge IDs, nunca um destinatário livre.
Somente users ativos são elegíveis. Nenhum método altera senha, e-mail verificado,
sessão, organização ou membership. O boolean de consumo não é sessão nem grant.

## Persistência e concorrência

Migration aditiva `1788900000000-CreateAuthEmailChallenges` cria
`auth_email_challenges`: `id`, `user_id`, `purpose`, `secret_hash`, `stage`,
`expires_at`, `failed_attempts`, `last_sent_at`, `send_window_started_at`,
`send_count`, `created_at`, `updated_at`. Há uma linha corrente por user/purpose;
índice de expiração, FK, constraints de finalidade, estado, hash, datas e contadores.
Estados atuais: `otp`, `consumed`, `invalidated`. Não existem `reset_authorized`,
grant ou `verification_context_hash`; pertencem às tarefas funcionais futuras.

Cada operação abre sua própria transação, adquire o lock de User já existente
`app_private.lock_auth_refresh_user(uuid)`, relê User e bloqueia o challenge.
Isso serializa inclusive a primeira emissão, quando ainda não existe linha.
`clock_timestamp()` é lido depois dos locks; espera por lock não prolonga a
validade observada. Nenhuma função executável nova: inventários históricos e
atuais de `app_private` permanecem intactos. A role runtime recebe somente
SELECT/INSERT/UPDATE na tabela nova; não ganha poderes nas tabelas centrais.

Reenvio troca ID, HMAC, expiração e tentativas da emissão, preservando janela e
contagem de envio. O cooldown vale mesmo se a janela horária terminar. Consumo
invalida o segredo armazenado. Erros de código aumentam o contador; na última
tentativa, o hash é apagado. Tentativas/consumo são commitados antes da auditoria
posterior e antes do retorno, portanto exceções posteriores não os desfazem.
Não passar EntityManager externo nem supor que o consumo participa de uma
transação do chamador. A composição com efeitos de verificação/reset será
definida em AUTH-V2-02/03; não usar o boolean como autenticação pública.

Linhas expiradas não são apagadas no caminho de request: o orçamento de envio
precisa sobreviver. Uma política posterior de limpeza deve preservar a janela
ativa de abuso. Há no máximo duas linhas por User; não é necessário um worker
de limpeza nesta fundação. Rollback da migration recusa dados/challenges ou
eventos OTP existentes, antes de remover objetos. Não faz data repair.

## Criptografia e envio

OTP gerado por `crypto.randomInt(1_000_000)`, preenchido até seis dígitos.
HMAC-SHA-256 autentica domínio v1, purpose, User, challenge e código, com
pepper exclusivo de 32 bytes. Comparação de hashes usa `timingSafeEqual`.
O banco não recebe o código em parâmetros SQL; recebe somente o HMAC.
Exceções de banco/provedor são convertidas em erro genérico sem cause, para não
propagar parâmetros sensíveis. Auditoria usa somente purpose allowlisted,
sem código, hash, grant, mensagem de e-mail ou erro bruto do provedor.

Emissão persiste challenge e auditoria, faz commit e só então chama Resend.
`ResendEmailTransport` é a extração do adapter existente; o import antigo de
invitations permanece como alias. Payload, timeout, Retry-After, classificação
de erros e idempotência de convites são preservados. A chave de idempotência OTP
é específica por emissão. Não há retry automático ou outbox de OTP.

Falha entre commit e envio, timeout ou entrega incerta mantém orçamento e
challenge; reenvio posterior recupera o fluxo. A resposta interna distingue
`sent`, `delivery_unavailable`, `rate_limited` e `unavailable`, sem segredo.
Ela não é contrato público: futuras rotas de recuperação devem impedir
enumeração, acrescentar limites por IP e proteger CSRF/contexto de verificação.

## Configuração e release

| Variável                         | Default / regra                                        |
| -------------------------------- | ------------------------------------------------------ |
| AUTH_OTP_PEPPER                  | Ausente; 32 bytes em base64 canônico, exclusivo de OTP |
| AUTH_OTP_TTL_SECONDS             | 600; entre 60 e 3600                                   |
| AUTH_OTP_MAX_ATTEMPTS            | 5; entre 1 e 10                                        |
| AUTH_OTP_RESEND_COOLDOWN_SECONDS | 60; entre 60 e 3600                                    |
| AUTH_OTP_SEND_WINDOW_SECONDS     | 3600; entre 60 e 86400                                 |
| AUTH_OTP_MAX_SENDS               | 5; entre 1 e 100                                       |
| AUTH_EMAIL_FROM                  | Vazio; remetente autorizado no Resend                  |

Transporte reutiliza RESEND_API_KEY/RESEND_API_URL e a configuração atual que
fixa o endpoint Resend em Production. Valores OTP fornecidos são validados no
startup. Ausência de pepper, remetente ou provedor deixa somente OTP indisponível;
login e invitation worker não passam a exigir esse segredo. O worker mantém seu
schema de configuração separado. A role runtime exige a migration aplicada
para operar; schema/permissão ausentes falham sem retornar prova válida.

Não reutilizar JWT secret, refresh pepper, keyring de convite ou de leads. A
validação rejeita reutilização literal dos segredos de sessão. Ao rotacionar o
pepper, códigos pendentes deixam de validar; budgets persistidos permanecem.

MIGRATION_REQUIRED=YES; API_RELEASE_REQUIRED=YES; WEB_CHANGED=NO;
PRODUCTION_CHANGED=NO; MEMORY_CHANGED=NO; DATA_REPAIR_REQUIRED=NO.

Release é posterior e exige autorização própria. Antes de habilitar o consumidor
público, fornecer pepper via mecanismo file-backed de secrets de Production e
remetente/provedor aprovados, com o wiring de runtime revisado nessa etapa.
Não adicionar segredo real a env examples. Esta entrega não altera Compose,
secret mounts, configuração remota ou readiness operacional de Production.
Smoke mínimo de futura release: migration presente/ACL preservada, health e
login/bootstrap existentes funcionando; teste interno com dados sintéticos e
envio controlado quando a habilitação de OTP for autorizada.

## Validação

Unit: RNG/zeros, HMAC/contexto, configuração, redaction e compatibilidade Resend.
PostgreSQL: cadeia completa de migrations, ACL, constraints, expiração,
tentativas duráveis, consumo/replay, concorrência entre conexões, cooldown,
orçamento após reenvio/reinício, isolamento e commit antes de envio.
Preservar regressões existentes de login/sessão e invitation delivery.
Governança Critical; surfaces pelo delta: app, production e tooling. Sem Web,
Playwright ou Memory. Evidência e ciclos ficam no handoff local transitório.
