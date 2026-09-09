<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v2.json -->

# Current project state

This is a deterministic projection. Edit [project-state.v2.json](memory/project-state.v2.json), then regenerate this file.

- **State revision:** AUTH-V2-02-PRODUCTION-KEEP-2026-09-09
- **Phase:** AUTH-V2 — Authentication V2
- **Last completed product work:** AUTH-V2-02 — Cadastro e verificação de e-mail
- **Outcome:** PRODUCTION_KEEP / AUTH-V2-02_LIVE
- **Current work:** none
- **Next task:** undecided — PENDING-PRODUCT-PRIORITIZATION

## Live bindings

- **API source:** f2f5d5bc6012065239fcdce223bce5dd4b590c70
- **API image:** ghcr.io/arthurportodev/genesis-platform-api@sha256:55b0ddb5b45a258941c35ddffb98c56f4848862fccb81ea4feee4a672fea6310
- **Web source:** 90493f8409576de1fd40008860aea6a86c274bf7
- **Web deployment:** dpl_9m3fyuxkeSruWTmXyb6sbMiz1mKi
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
