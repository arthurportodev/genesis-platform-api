<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v2.json -->

# Current project state

This is a deterministic projection. Edit [project-state.v2.json](memory/project-state.v2.json), then regenerate this file.

- **State revision:** AUTH-V2-03-PRODUCTION-KEEP-2026-09-10
- **Phase:** AUTH-V2 — Authentication V2
- **Last completed product work:** AUTH-V2-03 — Recuperação de senha e UX de senha
- **Outcome:** PRODUCTION_KEEP / AUTH-V2-03_LIVE
- **Current work:** none
- **Next task:** undecided — PENDING-PRODUCT-PRIORITIZATION

## Live bindings

- **API source:** c137ff1fb81ac5fc9b94a4b52f4190786477354e
- **API image:** ghcr.io/arthurportodev/genesis-platform-api@sha256:49e52a62de67cb0a37afaa88a70d2da71404c6e8736429716922b91592453759
- **Web source:** 8aeb682c6608ba467a47560d751ae51a271abe64
- **Web deployment:** dpl_AMKoVRsWx3cpzZfYyRyTLH1aHabT
- **Web domain:** https://app.agenciagenesismkt.com.br

## Open blockers

- None.

## Active restrictions

- **OR-SINGLE-VPS:** Production uses one VPS and one failure domain.
- **OR-SINGLE-REPLICA:** The public API remains limited to one replica while controls are process-local.
- **OR-VERCEL-HOBBY-TECHNICAL-MVP:** Review Vercel plan suitability before external onboarding or expanded commercial use.

## Follow-ups

- **FU-PIPELINE-CONFLICT-FEEDBACK:** Differentiate Pipeline configuration conflict feedback from stale-revision feedback instead of grouping HTTP 409 and 412 into the same Web message.
- **FU-TASK-VALIDATE-DATABASE-ENV:** Make surface-mode task validation provide the PostgreSQL DATABASE_* environment to database suites so explicit reruns are not required.
