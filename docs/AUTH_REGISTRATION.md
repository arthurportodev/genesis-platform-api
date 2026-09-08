# Cadastro e verificação de e-mail

## Contrato público

Os fluxos públicos permanecem desabilitados enquanto
`AUTH_OTP_PUBLIC_FLOWS_ENABLED=false`. Quando habilitados com a configuração
completa, a API oferece:

- `POST /api/v1/auth/register` com `firstName`, `lastName`, `email` e
  `password`;
- `POST /api/v1/auth/email-verification/resend` somente com `challengeId`;
- `POST /api/v1/auth/email-verification/verify` somente com `challengeId` e
  `code` numérico de seis dígitos.

Cadastro e verificação nunca criam uma sessão. O cadastro devolve
`verification_required`, o identificador do challenge, expiração, instante de
reenvio e o estado de entrega. A verificação devolve apenas
`{ "status": "email_verified" }`. Um login com senha correta e e-mail ainda
não verificado responde `403` com `code: EMAIL_VERIFICATION_REQUIRED` e, quando
disponível, o contexto mínimo do challenge. O contrato de sucesso do login de
uma conta verificada não muda.

## Persistência e segurança

`app_private.register_unverified_user(text,text,text)` cria somente um `User`
`ACTIVE` com `email_verified_at = NULL`. A função não cria Organization,
Membership, Session ou token. A constraint `UQ_users_email` continua sendo a
autoridade para concorrência e nenhuma conta existente é alterada por uma
tentativa duplicada.

`app_private.verify_user_email(uuid,uuid)` exige que o challenge informado
pertença ao User, tenha purpose `email_verification` e já esteja consumido. A
operação usa o relógio do banco. A API revoga sessões e refresh tokens
históricos no mesmo transaction boundary que registra a confirmação. O runtime
recebe `EXECUTE` somente nessas funções e continua sem `INSERT` ou `UPDATE`
genérico em `users`.

O código, cooldown, limite de tentativas, orçamento de envios, HMAC e transporte
continuam sob a fundação da AUTH-V2-01. O cliente nunca informa User, e-mail ou
purpose para continuar o fluxo. O hash Argon2id usa a política de Credentials e
compartilha o mesmo limite process-local empregado pela ativação de convites.

Login, refresh, bearer, `me` e bootstrap exigem User ativo e
`email_verified_at` preenchido. A ativação por convite continua marcando o
e-mail como verificado e não recebe um OTP adicional.

## Preparação de release futura

A configuração versionada monta na API os arquivos
`/opt/genesis/secrets/auth-otp-pepper` e
`/opt/genesis/secrets/resend-api-key`. `AUTH_EMAIL_FROM` é configuração não
secreta. Nenhum valor real faz parte do repositório.

Uma release futura deve seguir esta ordem:

1. instalar os dois secret files e definir `AUTH_EMAIL_FROM`;
2. manter `AUTH_OTP_PUBLIC_FLOWS_ENABLED=false` durante a preparação;
3. publicar API e aplicar a migration pelo operador canônico;
4. publicar a Web compatível;
5. validar health, login existente e os endpoints ainda fechados;
6. em uma janela separada e autorizada, mudar o flag para `true`, recriar somente
   a API e executar o smoke sintético de cadastro e verificação.

Rollback de aplicação não faz downgrade do schema. A migration é aditiva e as
funções ficam inativas enquanto o flag público estiver desligado.
