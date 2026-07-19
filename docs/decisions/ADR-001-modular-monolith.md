# ADR-001 — Monólito modular

- **Status:** Accepted
- **Data:** 2026-07-19 (registro retrospectivo de decisão já implementada)

## Contexto

A Genesis Platform está no início, com domínio e escala operacional ainda em evolução. Distribuir serviços agora aumentaria deploys, contratos, observabilidade e consistência de dados sem benefício comprovado.

## Decisão

Usar uma única aplicação NestJS e uma base de código, organizada em módulos com responsabilidades explícitas. Módulos podem compartilhar o processo e o PostgreSQL, mas devem preservar fronteiras de domínio e evitar dependências especulativas.

## Alternativas consideradas

- **Microservices desde o início:** adiados por complexidade operacional e de consistência prematura.
- **Aplicação sem módulos:** rejeitada por dificultar evolução, ownership e testes.

## Consequências

- Desenvolvimento, testes, deploy e transações começam simples.
- Refatorações internas permanecem mais baratas enquanto o domínio amadurece.
- Fronteiras precisam ser mantidas por disciplina; o processo único não fornece isolamento operacional entre módulos.
- Extração futura de serviços exigirá evidência de escala, autonomia ou risco operacional.

## Relações

- [Arquitetura](../ARCHITECTURE.md)
- [Roadmap](../ROADMAP.md)

## Implementação

`AppModule` agrega módulos de configuração, banco, health, identidade e autenticação. A decisão está implementada desde a fundação.
