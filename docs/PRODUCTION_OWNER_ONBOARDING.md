# Onboarding privado de OWNER em produção

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

Este runbook descreve o mecanismo versionado de criação inicial de uma
organização e de seu OWNER. O estado temporal da produção e qualquer
autorização vigente pertencem exclusivamente à
[memória canônica](memory/project-state.v1.json).

## Finalidade e limites

`npm run operator:owner -- create` cria atomicamente uma organização ativa, um
User ativo e uma Membership ativa com papel `OWNER`. O comando é um CLI
operacional privado, não é importado por `AppModule` ou `main` e não adiciona
rota pública, signup, migration ou contrato HTTP.

O processo não cria Lead, Session ou Refresh Token. Depois da criação, o
operador deve executar `status` para os três identificadores retornados e uma
pessoa deve fazer o login diretamente no navegador.

Se o receipt sanitizado de uma criação confirmada for perdido, `resolve`
recupera os três identificadores por e-mail normalizado e slug exato sem
autenticar o User ou modificar dados. Ele não substitui a verificação por
`status` e não pode ser usado para criar ou escolher identidades.

## Pré-condições

- usar uma imagem imutável, por digest, que contenha o CLI compilado;
- executar em TTY privado, com entrada e saída interativas;
- usar a role operacional de migration owner aprovada: login habilitado, owner
  do database e do schema `public`, sem superuser, `CREATEDB`, `CREATEROLE`,
  `BYPASSRLS`, `INHERIT` ou memberships;
- comprovar que todas as migrations versionadas estão aplicadas e que o schema
  atende ao contrato do onboarding;
- obter autorização humana específica para a identidade sanitizada exibida.

## Criação

Execute o entrypoint compilado pelo script npm:

```bash
npm run operator:owner -- create
```

O CLI coleta nome da organização, nome do OWNER, e-mail, senha e confirmação. A
senha e a confirmação são lidas sem eco. Antes de importar o data source ou
abrir conexão com o banco, o CLI mostra um resumo sanitizado e exige exatamente:

```text
AUTORIZO A CRIAÇÃO DA MINHA ORGANIZAÇÃO E CONTA OWNER DE PRODUÇÃO
```

A comparação é literal. Ausência, cancelamento ou divergência encerra o fluxo
sem criação. A senha nunca pode ser passada em argumento, arquivo de evidência,
log, conversa ou variável de ambiente persistente.

Depois dos preflights, a criação ocorre uma única vez em transação
`SERIALIZABLE`. Locks determinísticos, consultas de conflito e constraints
evitam duplicidade de e-mail, nome e slug; qualquer erro faz rollback integral.
O hash segue o serviço oficial de senha e o buffer de entrada é apagado da
memória ao término.

## Verificação por status

### Recuperação read-only do receipt

Use somente para uma identidade cuja criação já foi confirmada:

```bash
npm run operator:owner -- resolve \
  --email <normalized-email> \
  --organization-slug <organization-slug>
```

O resultado `RESOLVED` exige uma única combinação de User, Organization e
Membership ativa com papel `OWNER` e credential existente. Ausência ou mismatch
retornam `NOT_FOUND` sem campos de identidade. Estado inativo, papel divergente
ou ambiguidade retornam apenas o erro opaco `IDENTITY_NOT_RESOLVED`, também sem
identidade parcial. O comando executa somente consultas e não cria Session ou
Refresh Token.

Depois de `RESOLVED`, execute obrigatoriamente o `status` existente com os três
UUIDs retornados.

Use os três identificadores retornados pela criação, sem publicá-los em
documentação ou evidência versionada:

```bash
npm run operator:owner -- status \
  --organization-id <organization-id> \
  --user-id <user-id> \
  --membership-id <membership-id>
```

Sem argumentos, `status` solicita os mesmos identificadores interativamente.
O resultado esperado é `READY`, com organização, User e Membership ativos,
papel `OWNER`, exatamente um OWNER efetivo e contagens zero de Leads, Sessions
e Refresh Tokens. `NOT_FOUND`, invariantes inválidas ou qualquer issue exigem
interrupção; não repita `create` automaticamente.

## Smoke humano e evidência

Uma pessoa abre o domínio oficial, digita as credenciais diretamente no
navegador e confirma a organização correta e a Inbox inicial vazia. Não capture
senha, hash, cookie, token, e-mail, nome pessoal ou UUID. A evidência durável
registra somente resultado sanitizado, quantidade de OWNER efetivo, contagens,
commit/PR, digest da imagem e hashes do pacote sob custódia externa.

O CLI não é caminho de administração cotidiana. Novos usuários seguem os
fluxos de convite existentes ou uma tarefa operacional futura explicitamente
autorizada.
