# ADR-017 — Fronteira de confiança do proxy Vercel–Traefik

- Estado: Accepted provisionally
- Data: 2026-08-13
- Gate: 0.8-MVP-08 Gate 1

## Contexto

O navegador deve continuar usando exclusivamente caminhos relativos `/api/v1`,
com cookies de sessão host-only, CSRF cookie-to-header e validação estrita de
`Origin`. A origem da API não pode se tornar uma segunda superfície funcional
para o navegador, e o rate limiter precisa receber um IP que o cliente não
consiga escolher por headers arbitrários.

## Decisão

Uma Vercel Function Node.js no hostname exato
`app.agenciagenesismkt.com.br` é o único proxy funcional do navegador. Ela é
habilitada somente quando `VERCEL_ENV=production`, o target é exatamente
`https://api.agenciagenesismkt.com.br` e a chave server-only de origem está
presente e válida. Preview, hosts `*.vercel.app`, paths fora de `/api/v1` e
configuração incompleta falham fechados sem chamar a origem.

A cadeia de proveniência do IP é:

1. a plataforma Vercel encerra a conexão pública e sobrescreve o header de
   plataforma `x-vercel-forwarded-for`;
2. a Function exige um único IPv4/IPv6 canônico, remove todos os headers
   `Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, `X-Vercel-*`,
   `X-Genesis-*` e aliases explícitos de IP/CDN fornecidos na request, além dos
   headers hop-by-hop fixos e dos
   nomeados dinamicamente por `Connection`;
3. a Function grava server-side `X-Genesis-Origin-Key` e
   `X-Genesis-Client-IP` com o IP canônico;
4. o Traefik só seleciona o router funcional quando host, prefixo e chave
   coincidem; antes de encaminhar, remove a chave e sobrescreve
   `X-Genesis-Proxy-Attested: v1`;
5. a API exige exatamente uma atestação e exatamente um IP já canônico, rejeita
   chave vazada ou duplicidade, redige todos os headers internos/forwarded de
   `headers` e `rawHeaders` e guarda o IP em símbolo privado da request;
6. auth, invitations, memberships e leads consultam somente esse resolvedor
   central para rate limit e auditoria. `request.ip` é fallback exclusivo do
   modo local em que a atestação está desabilitada.

A posse da chave é necessária para alcançar o router funcional, mas a chave
nunca chega ao NestJS, environment da API, argumentos, logs ou configuração
versionada. O template versionado é materializado apenas em tmpfs do Traefik a
partir de arquivo montado; o access log padrão não captura headers. O Compose
base continua health-only e com atestação desabilitada. O override funcional é
aditivo, explícito e depende de Gate operacional e provisionamento posterior.

O proxy preserva método, query, body, status, `Origin`, cookie, CSRF, ETag,
`Retry-After`, rate-limit headers e cada `Set-Cookie` separadamente. Cookies de
upstream só são aceitos quando `Secure`, `Path=/`, sem `Domain` e sem controles.
`Location` só é devolvido como caminho relativo dentro de `/api/v1` quando a
origem é exatamente o app ou a API; qualquer destino externo, protocol-relative
ou fora do namespace falha fechado. Headers hop-by-hop fixos e indicados por
`Connection` são removidos nos dois sentidos.

Todas as respostas do proxy, inclusive erros, usam `Cache-Control`,
`CDN-Cache-Control` e `Vercel-CDN-Cache-Control: no-store`. Metadados de cache
do upstream, inclusive `Age`, `Surrogate-Control` e `X-Vercel-Cache`, são
removidos. Bodies são limitados a 4,5 MB e o timeout de upstream é menor que o
limite versionado da Function.

## Consequências

- A segurança do IP depende da garantia de sobrescrita do header de plataforma
  pela Vercel e da confidencialidade da chave de origem.
- Rotação/provisionamento da chave, mutação da VPS, router funcional, Vercel,
  DNS e deploy não são autorizados por este ADR.
- A ativação exige teste ponta a ponta após o deploy; testes locais provam a
  transformação e o fail-closed, não a configuração live da plataforma.
- O plano Hobby permanece limitado à validação técnica do MVP. Uso comercial
  exige nova revisão de plano e Gate humano.

## Alternativas rejeitadas

- Chamada direta do navegador à API: amplia CORS, cookies e bypass da origem.
- Confiar em `X-Forwarded-For` recebido pela API: permite falsificação e cadeia
  ambígua.
- Colocar a chave em bundle, `VITE_*`, query ou target: expõe a credencial.
- Habilitar o router funcional no Compose base: viola o default health-only.
