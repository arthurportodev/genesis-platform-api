# ADR-011 — Arquitetura da primeira produção

- Status: Superseded
- Data: 2026-07-30
- Superseded by: [ADR-013](ADR-013-mvp-production-baseline.md)

## Contexto

O backend e o frontend oficial concluíram o ciclo funcional da Fase `0.7`, mas
não existe ambiente publicado. A primeira produção precisa preservar sessão
cookie-only, CSRF, isolamento tenant, migrations controladas, privilégio mínimo
e operação recuperável, sem conectar Previews a dados reais ou expor API e
PostgreSQL diretamente.

O Gate 1 técnico da tarefa `0.8.0` foi estritamente read-only e recomendou uma
arquitetura com decisões humanas pendentes. O Product Owner aprovou as decisões
abaixo em 30 de julho de 2026.

Esta decisão foi superseded em 3 de agosto de 2026 pelo ADR-013. O conteúdo
abaixo permanece como registro histórico da primeira estratégia e não é mais
autoridade operacional vigente.

## Decisão

A primeira produção usa:

```text
Navegador
→ app.agenciagenesis.com.br
→ Vercel
→ proxy server-side de /api/v1
→ origin-api.agenciagenesis.com.br
→ Traefik
→ API NestJS
→ PostgreSQL 17
```

### Fronteiras de confiança

O navegador acessa apenas `/api/v1` no domínio `app`. A Vercel é a fronteira
server-side do proxy same-origin; Preview não recebe a origem de produção e
falha fechado. A origem usa HTTPS, aceita somente o caminho esperado pelo proxy
e bloqueia bypass. Traefik é o único ponto público do backend. Portas `3000` e
`5432` permanecem privadas, e forwarded headers/trust proxy são validados
contra a topologia real.

Cookies permanecem host-only no domínio `app`. O hop browser→Vercel não usa
CORS. O proxy preserva cookies, status, body e headers contratuais, aplica
`no-store` e nunca permite que o fallback SPA responda por `/api/v1`.

### PostgreSQL, roles e migrations

PostgreSQL 17 opera inicialmente em container dedicado na mesma VPS Hetzner,
com volume e rede próprios e sem bind público, desde que o inventário confirme
capacidade, segurança, armazenamento, backup e ausência de conflito. Caso
contrário, serão reavaliados VPS separada ou PostgreSQL gerenciado.

A API usa role runtime restrita, distinta da role owner temporária de
migrations. Um migration job único aplica migrations versionadas antes da
promoção da API. A credencial de migration não permanece disponível ao runtime.
A primeira produção usa uma réplica pública enquanto controles process-local
impedirem escala horizontal segura.

### Secrets, keyrings e imagens

Secrets usam secret files ou cofre; o fallback é arquivo root-owned `0600`,
fora do Git e da imagem. Keyrings preservam versões ainda necessárias e seguem
rotação e recuperação controladas. Imagens privadas ficam no GHCR e são
identificadas por commit SHA, digest, versão, scan e evidência de build.
`latest` não é fonte de verdade para deploy ou rollback.

### Backup, restore e observabilidade

Backups usam `pg_dump --format=custom`, criptografia e armazenamento externo à
VPS e ao mesmo failure domain, inicialmente a cada seis horas, com alerta de
atraso. Snapshot Hetzner é camada adicional. Restore sintético comprovado é
obrigatório antes de dados reais.

A operação observa uptime externo, VPS, containers, PostgreSQL, disco,
reinícios, TLS, migrations e backups. Uma solução existente só é reutilizada
depois de auditada. Provedor de object storage e ferramenta de monitoramento
permanecem decisões abertas.

### Deploy, rollback e abertura

O deploy é manual e controlado inicialmente, sempre por imagem imutável e
migration job bloqueante. Rollback da API fixa digest anterior e não reverte
schema automaticamente; frontend e DNS possuem rollback próprio.

Staging não será criado inicialmente. Convites e email ficam desabilitados na
primeira abertura. A sequência é infraestrutura → dados sintéticos → owner →
equipe interna → novas Organizations. Bootstrap cria o owner por credencial
temporária fora do Git/imagem, substituída após o primeiro acesso e removida em
seguida. Dados reais exigem restore, smoke, alertas, origem protegida, portas
privadas, credencial rotacionada e aprovação humana específica.

## Alternativas consideradas

- **Browser → origem backend com CORS:** rejeitada para a primeira produção por
  ampliar exposição da origem e complexidade de cookies, CSRF e allowlists.
- **Frontend hospedado junto ao backend na Hetzner:** rejeitada por abandonar o
  destino Vercel aprovado e acoplar ciclos de publicação sem necessidade atual.
- **PostgreSQL em VPS separada ou gerenciado desde o início:** não escolhido
  como padrão inicial, mas obrigatório de reavaliar se o inventário reprovar a
  mesma VPS.
- **Múltiplas réplicas públicas:** adiada enquanto rate limits, semaphores e
  coordenações relevantes forem process-local.
- **Staging inicial:** adiado; Preview permanece sem API de produção.
- **Deploy totalmente automatizado:** adiado até a operação manual produzir
  runbooks, observabilidade e rollback comprovados.

## Consequências

A arquitetura preserva same-origin no navegador e separa publicação web da
operação da API. Em contrapartida, Vercel e origem se tornam fronteiras de
confiança que exigem configuração e testes coordenados. A mesma VPS reduz
complexidade inicial, mas condiciona banco e disponibilidade a um inventário
rigoroso e a backup externo. Uma réplica preserva corretude dos controles
process-local, mas limita disponibilidade e escala até trabalho futuro.

A decisão não prova que Vercel, Hetzner, DNS, banco, secrets, registry, backup,
monitoramento ou deploy estejam configurados. Publicação técnica também não
prova prontidão operacional.

## Relações

- O [ADR-010](ADR-010-web-session-contract.md) continua definindo sessão web,
  cookies, CSRF, Origin, CORS e bootstrap.
- O ADR-008 do frontend registra a parte Vercel/same-origin desta decisão.
- O [ADR-013](ADR-013-mvp-production-baseline.md) supersede esta decisão e
  define a baseline mínima vigente.
- [PRODUCTION.md](../PRODUCTION.md) é a autoridade operacional atual e não usa
  mais o DAG registrado neste ADR.

## Implementação

A sequência `0.8.2`–`0.8.11` pertence somente ao plano histórico desta decisão
e não é mais a baseline ativa. Nenhuma implementação, branch ou Pull Request
da estratégia anterior deve ser promovido automaticamente ao MVP. A execução
vigente segue o ADR-013 e a sequência `0.8-MVP` documentada no roadmap.
