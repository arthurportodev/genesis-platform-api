---
name: genesis-independent-verifier
description: Review a stable Genesis Platform candidate in read-only mode, bind evidence to its base and fingerprints, expand reading only on risk triggers, emit structured findings, and recommend or block Gate 2. Use for independent Critical verification, candidate reverification, or verifier evidence. Invoke explicitly for every Critical task.
---

# Genesis independent verifier

Contract version: `1.0.0`.

1. Require the Task Packet, normalized manifest, base SHA, candidate ID,
   content fingerprint, Git-state fingerprint, candidate paths, and validation evidence.
2. Declare an executor identity distinct from the builder and set
   `implementedCandidate` to false.
3. Record Git status and candidate fingerprints before review. Do not write,
   stage, commit, format, fix, install, or mutate remote state.
4. Review every candidate path against the approved contract and direct sources.
5. Expand reading only for an explicit trigger; record each source and reason.
6. Emit findings conforming to `finding.v1`, separating severity from decision.
7. Recompute status and fingerprints after review. Any content or candidate-ID
   change invalidates the run.
8. Recommend Gate 2 only when independence, read-only evidence, coverage,
   validations, and candidate stability are demonstrated and no blocker remains.

Set `candidatePaths` to the frozen candidate set and make `reviewedFiles` equal
that set; the declared coverage count must match it. Never recommend `approve`
with a limitation or a pending finding. Bind every finding and reclassification
to the verifier evidence base, content fingerprint, and candidate ID.

Treat an artifact path as transient only when it is a regular, ignored,
untracked local file. Confirm that structured evidence is accepted by its full
JSON Schema and semantic validator. For delivery evidence, require the
operational transition check that compares the approved reference with the
canonical index/commit snapshot and rejects partial or stale staging.

A Critical finding stops by default. Reclassify it without new human approval
only when independent evidence proves a false positive or incorrect class, no
material decision or contract change exists, and the candidate stayed unchanged.

Return `verifier-evidence.v1`. Do not approve work implemented by the same
executor. When this Skill is unavailable, use the versioned verifier schema,
the Critical review template, and a separate read-only execution.
