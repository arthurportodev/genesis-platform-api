# AUTH-V2-04 — Aprendizados de release

Este documento registra aprendizados factuais da AUTH-V2-04. Ele é não
normativo: não cria ADR, processo obrigatório, Gate, workflow, tooling ou state
machine.

## Promoção Web

- Um Preview candidate e um candidate materializado com o ambiente de
  Production representam estados diferentes na Vercel.
- A execução determinística materializou o candidate aprovado com o ambiente
  de Production e sem atribuir o domínio canônico antes da promoção humana.
- A igualdade do deployment ID, isoladamente, não define o sucesso da
  promoção. A AUTH-V2-04 validou em conjunto a proveniência da promoção, o
  control plane e o conteúdo servido pelo domínio canônico.
- Um deployment derivado durante `promote` não representa falha por si só. Sua
  validade depende da proveniência e do estado canônico observados.

## Recuperação observada

Quando o control plane e o content plane divergiram, o rollout falhou de forma
segura: o fluxo público do Google foi desligado temporariamente, enquanto a
application source, o schema e a imagem da API permaneceram live. A retomada
investigou a divergência e preservou a arquitetura existente.

O feature flag permitiu separar disponibilidade da fundação técnica e abertura
pública. Essa separação tornou possível manter o suporte de identidade Google
implantado enquanto a promoção Web era corrigida.

## Preparação e continuidade

Artefatos de preparação e source materializado foram produzidos durante
Release Readiness como evidência, sem serem tratados como mutação de runtime. A
remediação da promoção Web continuou no mesmo Production Rollout porque o
objetivo e o escopo da AUTH-V2-04 permaneceram os mesmos.
