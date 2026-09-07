<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v2.json -->

# Current project state

This is a deterministic projection. Edit [project-state.v2.json](memory/project-state.v2.json), then regenerate this file.

- **State revision:** PIPE-V2-06-PRODUCTION-KEEP-2026-09-07
- **Phase:** PIPE-V2 — Pipeline Experience V2
- **Last completed product work:** PIPE-V2-06 — Custom Pipelines & Stages
- **Outcome:** PRODUCTION_KEEP / PIPE-V2-06_LIVE
- **Current work:** none
- **Next task:** undecided — PENDING-ROADMAP-PRIORITIZATION

## Live bindings

- **API source:** 30d999876ad67472c019bd540a166e61ceee61ca
- **API image:** ghcr.io/arthurportodev/genesis-platform-api@sha256:416c997915c49d7331d517c879c485f1e312585a0a32786f3464cd808d0f97a3
- **Web source:** daab09257c335a2fb53b592a525bc5518bdf17c1
- **Web deployment:** dpl_ArBFkjj28BDHcrE1rFHewCyzAQKH
- **Web domain:** https://app.agenciagenesismkt.com.br

## Open blockers

- None.

## Active restrictions

- **OR-SINGLE-VPS:** Production uses one VPS and one failure domain.
- **OR-SINGLE-REPLICA:** The public API remains limited to one replica while controls are process-local.
- **OR-VERCEL-HOBBY-TECHNICAL-MVP:** Review Vercel plan suitability before external onboarding or expanded commercial use.

## Follow-ups

- **FU-VERCEL-EXACT-IDENTITY:** Before the next Web release, reconcile the Vercel runbook so exact-deployment releases use a staged Production candidate and prior Production deployments are restored through routing/Instant Rollback without rebuild.
- **FU-PIPELINE-CONFLICT-FEEDBACK:** Differentiate Pipeline configuration conflict feedback from stale-revision feedback instead of grouping HTTP 409 and 412 into the same Web message.
- **FU-TASK-VALIDATE-DATABASE-ENV:** Make surface-mode task validation provide the PostgreSQL DATABASE_* environment to database suites so explicit reruns are not required.
