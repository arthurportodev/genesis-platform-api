# ADR-018 — Contrato íntegro e ativação atômica da árvore de release

- Estado: Accepted
- Data: 2026-08-14
- Gate: 0.8-MVP-08B-R2 versioned remediation

## Contexto

A auditoria read-only da árvore `/opt/genesis/release` encontrou todos os onze
diretórios `root:root 0777`, dois arquivos canônicos ausentes e oito arquivos
com conteúdo diferente do committed release vigente. O manifesto anterior
fixava hashes e modes de arquivos, mas não owners, groups e modes de diretórios.
Remover apenas o `0777` não comprovaria retroativamente a integridade dos bytes.

## Decisão

O bundle `0.8-MVP-08.v2` inclui no próprio `release-manifest.json`:

- os onze diretórios esperados como `root:root 0755`;
- cada arquivo regular como `root:root`, preservando seu mode Git/manifest;
- `/opt/genesis` como `root:root 0755`;
- staging inicial `root:root 0700`;
- rollback como sibling v2 derivado para a imagem `previous-approved`;
- quarentena `root:root 0700`, marcada `UNTRUSTED` e inelegível para rollback;
- lock exclusivo `root:root 0600`;
- ativação exclusivamente por `renameat2(RENAME_EXCHANGE)` no mesmo device.

Directory metadata faz parte dos bytes do manifesto e, portanto, do fingerprint
do bundle. Scripts chamados por `/bin/sh`, `/bin/bash` ou `python3` continuam
`0644`; execute bit não é concedido por conveniência.

Cada committed release declara `releaseRole=current|rollback`. O papel
`rollback` não aceita imagem arbitrária nem reutiliza o manifesto corrente: o
builder parte do mesmo snapshot Git que contém o contrato v2 e deriva somente
`compose.production.yml`, trocando exatamente as duas referências imutáveis da
imagem corrente pela imagem `previous-approved`. O manifesto registra hash da
fonte, valores `from`/`to` e contagem de substituições. Builder e validator
recusam qualquer outra transformação; o manager exige papel, imagem e
fingerprint distintos para current e rollback, o mesmo `sourceCommit` e
igualdade byte a byte e de metadata para todo artefato fora do Compose.

O procedimento versionado valida o bundle corrente e o rollback antes de tocar
na árvore ativa. Ele constrói ambos em siblings a partir dos bundles canônicos,
aplica metadata, rejeita path inesperado, tipo especial, hash, owner/group/mode,
ACL, symlink, hardlink e mount boundary, sincroniza arquivos/diretórios e prova
a troca atômica entre os dois siblings. Somente então troca staging e active.

A árvore ativa anterior nunca é fonte de staging nem rollback. Após a troca ela
permanece no path de staging, restrita a root e marcada `UNTRUSTED`, sem remoção
automática. Se a validação imediatamente posterior falhar, o procedimento troca
a árvore ativa pelo rollback previamente verificado; não restaura a árvore
antiga não confiável. Ausência ou incompatibilidade da primitiva termina como
`ATOMIC_PRIMITIVE_UNAVAILABLE`; uma sequência de `mv` não é fallback.

Permanecem fora da travessia e da troca `/opt/genesis/secrets`,
`/opt/genesis/recovery`, `/opt/genesis/traefik-state`,
`/var/lib/genesis/recovery` e `/var/lib/docker`. Assim, a correção não exige
restart de container, não acessa PostgreSQL e não altera volumes, ACME, backup,
retenção, RPO ou destino remoto.

## Consequências

- A árvore remota continua `UNPROVEN` até uma operação futura aplicar e validar
  um novo committed release sob Gate explícito.
- O rollback exige bundle anterior regenerado, fingerprint e imagem rollback
  explicitamente vinculados. Ele é um novo artefato v2 derivado do containing
  commit aprovado com a única substituição contratada de imagem; a árvore
  `0777` observada e um manifesto histórico v1 nunca são rollback.
- A operação requer root, lock exclusivo, mesmo filesystem e suporte efetivo a
  `renameat2(RENAME_EXCHANGE)`.
- O contrato adiciona tooling de release e testes Linux, sem alterar aplicação,
  dependency graph, runtime da imagem, migration ou Compose.

## Alternativas rejeitadas

- `chmod/chown` in-place: não recupera prova de conteúdo após parents `0777`.
- Copiar da árvore ativa: propaga bytes cuja integridade não está provada.
- Dois `mv` sequenciais: cria intervalo sem active path e não é troca atômica.
- Restaurar automaticamente a árvore antiga: transforma estado não confiável
  em rollback operacional.
- Guardar secrets ou runtime state no release: amplia a superfície da troca e
  viola o contrato de custódia externa.
