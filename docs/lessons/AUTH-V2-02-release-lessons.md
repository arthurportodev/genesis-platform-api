# AUTH-V2-02 — Aprendizados de preparação e deploy

Este documento registra aprendizados da AUTH-V2-02.
Ele não define um processo obrigatório de deploy.

## Contexto

A AUTH-V2-02 entregou cadastro público, verificação por OTP, envio de e-mail
real, migration, API, Web e ativação pública. A preparação e a execução em
Production mostraram como uma feature pronta pode encontrar lacunas no caminho
de release vigente.

Os pontos abaixo ajudam a pensar releases futuras. Eles devem ser adaptados ao
delta, ao risco e às dependências de cada feature, sem reproduzir
automaticamente o caminho detalhado da AUTH-V2-02.

## O que deu certo

- Separar a implementação da feature da infraestrutura necessária para
  publicá-la.
- Construir e validar a feature antes de iniciar a execução em Production.
- Simular o caminho inteiro, do estado atual até `KEEP`, antes da primeira
  mutação.
- Mapear o rollback junto com o caminho de promoção.
- Materializar os candidates de API e Web antes do Gate de Production.
- Promover a API por digest imutável.
- Separar a identidade do application source da identidade do operational
  source.
- Manter `publicFlows=false` para estabilizar a API antes da abertura pública.
- Validar a integração externa por meio de um smoke real.
- Usar intervenção humana quando ela era mais simples e confiável.
- Acionar um circuit breaker de complexidade quando uma correção pequena
  começou a puxar arquitetura desproporcional.
- Distinguir erro operacional de lacuna arquitetural antes de criar trabalho
  adicional.

## O que deu errado

- Blockers foram descobertos um por um durante a preparação.
- Cada blocker acabou se transformando em uma nova tarefa de infraestrutura.
- Foram criados Gates cuja função era preparar outros Gates.
- A aprovação externa foi duplicada em `api-release-evidence.json` no host.
- O fluxo acumulou excesso de strings e identidades fornecidas por pessoas.
- Erros acidentais de quoting, encoding, `umask` e bytecode influenciaram o
  desenho da solução.
- Algumas partes foram automatizadas sem uma necessidade proporcional.
- O primeiro smoke de OTP começou com um e-mail sem inbox controlado.

Esses acidentes ajudam a melhorar a execução, mas não justificam novas regras
arquiteturais por si só.

## O que virou princípio

1. Pensar a release inteira antes da primeira mutação.
2. RISK define governança; DELTA define validação.
3. Diferenciar gap estrutural, gap procedural e erro de execução.
4. Corrigir o menor delta necessário.
5. Usar um circuit breaker quando uma correção pequena começa a exigir
   arquitetura desproporcional.
6. Preparar o rollback junto com o forward path.
7. Validar integrações externas de forma real quando a feature depende delas.
8. Depois de um `KEEP` terminal, encerrar a tarefa sem transformar o closeout
   em oportunidade para melhorias preventivas.

## O que não devemos repetir

- Descobrir arquitetura durante uma execução em Production.
- Criar infraestrutura para resolver um erro acidental.
- Adicionar authority, manifest ou Gate sem necessidade demonstrada.
- Assumir que toda feature precisa do mesmo rollout da AUTH-V2-02.
- Reutilizar automaticamente processos complexos apenas porque eles já
  existem.
- Automatizar um smoke quando uma validação humana controlada é mais simples e
  confiável.

## Como isso muda as próximas tarefas

Antes de cada nova feature:

1. implementar a feature;
2. identificar exatamente o delta produzido;
3. comparar esse delta com o deploy vigente;
4. simular o caminho completo para `KEEP` e rollback;
5. listar as lacunas reais;
6. decidir o menor caminho seguro para corrigi-las.

A aplicação dessa heurística depende do caso. Uma mudança sem migration pode
usar Level 1, enquanto uma mudança com migration pode exigir Level 2. Uma
integração externa pode precisar de validação real. Uma feature sem abertura
pública pode não precisar de feature flag. Outra feature pode exigir uma ordem
diferente da usada na AUTH-V2-02.

Reutilizamos princípios; não copiamos mecanicamente o processo.
