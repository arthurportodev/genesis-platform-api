<!-- generated-by: scripts/validate-project-memory.cjs; source: docs/memory/project-state.v2.json -->

# Current project state

This is a deterministic projection. Edit [project-state.v2.json](memory/project-state.v2.json), then regenerate this file.

- **State revision:** AUTH-V2-01-PRODUCTION-KEEP-2026-09-08
- **Phase:** AUTH-V2 — Authentication V2
- **Last completed product work:** AUTH-V2-01 — Fundação de Challenges e Envio OTP
- **Outcome:** PRODUCTION_KEEP / AUTH-V2-01_LIVE
- **Current work:** none
- **Next task:** AUTH-V2-02 — Cadastro e verificação de e-mail

## Live bindings

- **API source:** 9c031ff0e3790d6b0b6628a3435ca3a3d22fb48a
- **API image:** ghcr.io/arthurportodev/genesis-platform-api@sha256:80fe64c2fb563c308bc7aecf6d212aed89cbc06bffcfbcd12d4a1ee7b584fcc0
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
