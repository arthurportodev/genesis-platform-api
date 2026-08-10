# ADR-013 — Baseline mínima de produção do MVP

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

Este ADR preserva decisões e riscos aceitos. Status operacional, release gates
e restrições atuais são resolvidos somente em
`docs/memory/project-state.v1.json`.

- **Status:** Accepted
- **Data:** 2026-08-03
- **Última reconciliação documental:** 2026-08-10

## Contexto

A fundação, o backend, o frontend e o CRM da Genesis Platform já existem. O
produto ainda é um MVP e não está publicado nem autorizado para dados reais. A
primeira estratégia de produção ficou desproporcional ao estágio do produto:
seu experimento de alta garantia produziu conhecimento útil, mas não será um
requisito para colocar o MVP em uso.

O objetivo atual é permitir que usuários reais testem o produto existente com
uma operação pequena, compreensível e recuperável. Segurança continua
obrigatória, em proporção ao risco atual, e será ampliada conforme adoção,
volume de dados e receita crescerem.

## Decisão

### Topologia mínima

```text
Navegador
→ frontend na Vercel em app.agenciagenesismkt.com.br
→ proxy same-origin de /api/v1
→ API oficial em api.agenciagenesismkt.com.br
→ Traefik
→ uma instância da API NestJS
→ PostgreSQL 17 em rede privada
```

O navegador continua usando paths relativos `/api/v1`; chamadas cross-origin
diretas não substituem esse contrato. Somente o Traefik publica a origem da
API. As portas da API e do PostgreSQL não são expostas diretamente.

Os hostnames oficiais aprovados são `app.agenciagenesismkt.com.br` para o
frontend e `api.agenciagenesismkt.com.br` para a API. Eles definem destino
arquitetural; este ADR não afirma DNS, TLS, Vercel, Traefik ou qualquer serviço
como operacionalmente ativo.

### Infraestrutura inicial

- VPS Hostinger KVM 2 dedicada, com 2 vCPU, 8 GB de RAM e 100 GB NVMe;
- uma única VPS e uma única réplica pública da API inicialmente;
- PostgreSQL 17 em container dedicado ou equivalente, com persistência e rede
  privada;
- Traefik, API NestJS em container e PostgreSQL em rede privada como serviços
  mínimos;
- backup externo no Google Drive, com restore sintético obrigatório;
- UptimeRobot como monitoramento externo do endpoint `/health`;
- somente o ambiente de produção na etapa inicial, sem staging;
- Redis, n8n, Evolution API, Portainer e outros serviços somente quando uma
  funcionalidade do MVP comprovar a necessidade.

### Entrega

O fluxo inicial é GitHub → CI essencial → imagem Docker → GHCR privado →
aprovação humana → VPS → migration controlada → health e smoke → manter ou
rollback. O registry-alvo do MVP é GHCR privado. A imagem é identificada pela
tag do commit e, quando publicada, por digest. O deploy inicial manual está
aprovado e o rollback manual deve estar documentado.

### Distinção entre decisão, implementação e observação

As escolhas desta seção são arquitetura ou destino aprovados. Implementação só
é comprovada por código, migrations e testes da `main`. Estado live exige
observação operacional autorizada e pertence à memória temporal canônica. Em
particular, o histórico de um package GHCR público deve ser preservado, mas não
comprova a visibilidade live atual; a transição para o alvo privado exige tarefa
própria e evidência operacional.

RPO, RTO e retenção de backup, política de alertas, destinatários e
escalonamento, além da autorização dos primeiros usuários e dados reais,
continuam decisões materiais separadas destas escolhas arquiteturais.

### Segurança mínima

São obrigatórios:

- isolamento entre Organizations e teste cross-tenant;
- autenticação, autorização e papéis `owner`, `admin` e `member`;
- secrets fora do Git, do frontend, das imagens e dos logs;
- HTTPS e origem protegida;
- PostgreSQL privado, persistência, roles separadas e migrations controladas;
- backup, restore testado, logs sanitizados, health e rollback;
- bloqueio de vulnerabilidade Critical aplicável até tratamento ou decisão
  humana explícita;
- smoke do fluxo principal antes da abertura.

### Runtime health

O runtime health foi implementado no commit
`c2e39cee2ea05f6e0a23edd150268024b2ebe94c` e incorporado à `main` com a
rebaseline documental pelo PR #29 no squash
`5e76b4fde61badce3a39792f7ba9e3ee6ea806ce`. A CI pós-merge `30892867828` foi
aprovada integralmente; infraestrutura e dados reais permanecem fora do que foi
incorporado.

- lifecycle monotônico `starting → ready → draining → stopped`;
- liveness independente do PostgreSQL;
- readiness vinculada ao estado do runtime e a `SELECT 1`, com deadline de
  resposta de 1,5 segundo;
- shutdown coordenado com deadline de 12 segundos e saída normal após os hooks;
- respostas mínimas, sanitizadas e com `Cache-Control: no-store`.

### Controles adiados

Pertencem ao backlog de maturidade e não bloqueiam automaticamente o primeiro
MVP: binder multidomínio customizado, reconciliação formal de todas as
identidades OCI, atomic output-set avançado, packages reconstruíveis de alta
garantia, verificador independente obrigatório para toda alteração, provas
equivalentes Windows/Linux em todo delta, banco Grype formalmente selado, SBOM
como gate obrigatório, attestations avançadas, auditoria criptográfica completa
de todos os boundaries, pipeline customizado de supply chain e deploy totalmente
automatizado.

## Riscos aceitos

- uma única VPS é um failure domain único;
- uma única réplica reduz disponibilidade;
- o timeout de readiness decide a resposta, mas não cancela fisicamente a query;
- o deploy manual depende de disciplina operacional;
- o monitoramento inicial será básico;
- a segurança deverá evoluir conforme adoção, dados e risco aumentarem.

## Consequências

A baseline reduz o tempo para colocar o MVP no ar, torna a arquitetura mais
compreensível, reduz consumo local e operacional e elimina a necessidade
imediata de código customizado de supply chain. Em contrapartida, backup,
restore e rollback precisam continuar reais e testados, e a arquitetura deve
ser revista quando usuários, dados e receita crescerem.

## Relações

- O [ADR-010](ADR-010-web-session-contract.md) continua vigente para sessão web.
- O [ADR-011](ADR-011-production-architecture.md) foi superseded por esta decisão.
- O [ADR-012](ADR-012-development-operating-system-v2.md) continua vigente para
  o processo de desenvolvimento.
- O [ADR-014](ADR-014-versioned-production-contract.md) especializa esta
  baseline para PostgreSQL, secrets, imagens e bundle da `0.8-MVP-05A`.
- [PRODUCTION.md](../PRODUCTION.md) define contratos e runbooks operacionais;
  estado temporal é resolvido pela memória canônica.

## Registro histórico de implementação

O runtime health, container/Compose e CI/GHCR estão incorporados. A
`0.8-MVP-05A`, incluindo `CORR-01`, `CORR-02` e `CORR-03`, foi incorporada pelo
PR #35 no squash `5268706d22cb69df7d065928c16b4425a03b41cf`; a CI pós-merge
`31286630732` foi aprovada. O contrato detalhado no ADR-014 está na `main`. O
delta retornou `shouldPublish=false`, não executou o publicador, não criou tag
nova e preservou o digest da API
`sha256:56ada3e6bea3ab96b0bbb77fa456b8107663f92e82f8724ea05cb04d8b5cf659`.

Um bundle pós-merge `committed-release` foi validado como operacional contra o
snapshot do squash, com `sourceCommit` correspondente, seis arquivos e modes
`0644`; não foi transferido à VPS. O histórico pré-merge em modo `candidate`
continua evidência local não operacional. Esta incorporação não instalou a
stack, não criou secrets reais, volume ou banco, não executou migrations,
serviços, portas ou deploy e não autoriza dados reais.

A situação temporal da `0.8-MVP-05B` não é definida por este ADR. Consulte a
memória canônica; nenhuma decisão registrada aqui autoriza operação em VPS.
Os demais componentes seguem até `0.8-MVP-09`, cada um com escopo e validação
próprios.
