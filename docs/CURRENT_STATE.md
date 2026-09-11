<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v2.json -->

# Current project state

This is a deterministic projection. Edit [project-state.v2.json](memory/project-state.v2.json), then regenerate this file.

- **State revision:** AUTH-V2-04-PRODUCTION-KEEP-2026-09-10
- **Phase:** AUTH-V2 — Authentication V2
- **Last completed product work:** AUTH-V2-04 — Google + identidade única
- **Outcome:** PRODUCTION_KEEP / AUTH-V2-04_LIVE
- **Current work:** none
- **Next task:** undecided — PENDING-PRODUCT-PRIORITIZATION

## Live bindings

- **API source:** f6a68930fcd472951ee063390c998a28988d31ff
- **API image:** ghcr.io/arthurportodev/genesis-platform-api@sha256:51590836e65d74ecb14ced583f2702b6e1d47ba77b947018c15f3e8911260bc9
- **Web source:** 3db482c91cf2c767c1bcba34f7069c1b194f986a
- **Web deployment:** dpl_59AJgPRJoVbFgJWgpUxcv8SQMTvx
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
