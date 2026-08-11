# ADR-015 — Traefik, HTTPS e edge health-only

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

Este ADR registra decisão arquitetural. Incorporação e estado live são
resolvidos por código/testes da `main` e pela memória temporal canônica.

- **Status:** Accepted
- **Data:** 2026-08-10

## Contexto

A baseline privada da API e do PostgreSQL existe sem Traefik, DNS de API ou
bindings 80/443. O Docker publica portas antes das chains normais usadas pelo
UFW; portanto “binding wildcard com UFW fechado” não é preparação privada.
Além disso, publicar a API funcional antes do proxy same-origin do frontend
criaria uma origem de bypass.

## Decisão

Traefik oficial estável, fixado por digest e `linux/amd64`, será o único edge.
Ele usa file provider sem Docker socket, dashboard/API desabilitados e nenhuma
porta 8080. O Compose base não possui `ports`; três overrides mutuamente
exclusivos substituem integralmente a lista:

- `internal`: `127.0.0.1:18080→80` e `127.0.0.1:18443→443`;
- `public-http`: `0.0.0.0:80→80` e `127.0.0.1:18443→443`;
- `public-full`: `0.0.0.0:80→80` e `0.0.0.0:443→443`.

IPv6 wildcard e bindings 3000, 5432, 8080 ou implícitos são proibidos. UFW é
defesa do host, não gate de publicação Docker.

O único router encaminha
`Host(api.agenciagenesismkt.com.br) && Path(/health) && Method(GET)` para
`http://api:3000`. Rotas funcionais, hosts e métodos adicionais falham
fechados. `FRONTEND_URL=https://genesis.invalid` permanece até a tarefa Web.

TLS usa ACME HTTP-01 na porta 80. Configurações internal, staging e produção
são separadas; staging e produção usam arquivos de estado diferentes,
persistentes, regulares e `0600`, externos ao Git. O email ACME é parâmetro não
secreto obrigatório. A porta 443 só se torna pública após certificado de
produção válido localmente.

A API usa `TRUST_PROXY_HOPS=1` somente com Traefik. Testes devem provar IP
legítimo e impedir que X-Forwarded-For forjado controle rate limit/auditoria.
Remover Traefik exige restaurar zero hops e recriar somente a API.

## Alternativas consideradas

- DNS-01: rejeitado no MVP por exigir credencial DNS e não haver wildcard.
- Certificado manual: rejeitado por renovação operacional recorrente.
- Binding wildcard com UFW fechado: rejeitado porque UFW não governa sozinho
  portas Docker publicadas.
- Regras `DOCKER-USER`: adiadas; aumentam risco e exigem tarefa/rollback próprios.
- API funcional pública: adiada até o proxy same-origin do frontend.

## Consequências

A preparação pode ser validada em loopback sem exposição pública, e as duas
mutações de exposição ficam explícitas nos modos `public-http` e
`public-full`. Em contrapartida, a réplica única exige breve recriação da API
para aplicar trust proxy, a porta 80 precisa permanecer disponível para
renovação e a operação live depende de autorizações separadas, DNS, ACME e
smoke externo.

## Implementação e estado

A `0.8-MVP-06A` prepara Compose, configurações, validators, testes e bundle
para Gate 2. Ela não executa DNS, bindings públicos, ACME, certificados ou
deploy. Somente uma operação futura incorporada pode observar HTTPS; somente o
closeout `06B` pode registrar essa observação e concluir a `0.8-MVP-06`.

## Relações

- Especializa o [ADR-013](ADR-013-mvp-production-baseline.md).
- Preserva o contrato de bundle do [ADR-014](ADR-014-versioned-production-contract.md).
- O runbook está em [PRODUCTION.md](../PRODUCTION.md) e os controles em
  [SECURITY.md](../SECURITY.md).
