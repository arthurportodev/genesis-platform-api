<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v2.json -->

# Current project state

This is a deterministic projection. Edit [project-state.v2.json](memory/project-state.v2.json), then regenerate this file.

- **State revision:** ONBOARDING-V1-01-PRODUCTION-KEEP-2026-09-11
- **Phase:** ONBOARDING-V1 — Onboarding self-service
- **Last completed product work:** ONBOARDING-V1-01 — Criação self-service de organização
- **Outcome:** PRODUCTION_KEEP / ONBOARDING-V1-01_LIVE
- **Current work:** none
- **Next task:** undecided — PENDING-PRODUCT-PRIORITIZATION

## Live bindings

- **API source:** d2bf1e1d2e1a1cfa8f4181d2b14f739f72a4e85d
- **API image:** ghcr.io/arthurportodev/genesis-platform-api@sha256:1e2572e4248d5f533a740bd885cdadee5f5431023e8e44f58f449153daf248f0
- **Web source:** 74d1ce2d7c3b0a430a78c7ff2e11e35ad678f3cb
- **Web deployment:** dpl_DKswBb4CWdmMYvdELYNUqJWn7hmV
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
- **FU-WEB-PRODUCTION-STAGED-PROMOTION:** Align Web release tooling with Vercel Production-staged semantics: materialize the approved candidate with the Production environment and no canonical domain assignment before human promotion, then validate provenance and canonical content without assuming the deployment ID remains unchanged.
- **FU-WEB-LEAD-CONTRACT-TYPE-NARROWING:** Resolve the pre-existing TypeScript TS2345 in src/server/api-proxy.ts by narrowing the validated lead contract value before passing it to buildUpstreamHeaders.
