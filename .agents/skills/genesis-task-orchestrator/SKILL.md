---
name: genesis-task-orchestrator
description: Plan Genesis Platform tasks from an approved delta, classify risk, select canonical sources, define roles, Gates, validation, autonomy, and a minimal Task Packet. Use for task intake, rehydration, classification, Gate planning, or when a prompt is becoming a broad project reread. Invoke explicitly for every Critical task.
---

# Genesis task orchestrator

Contract version: `2.0.0`.

1. Confirm the repository, remote base, branch intent, and concurrent work before writing.
2. Answer: what changes, which contracts are touched, which files are authorities, and which risks are new.
3. Start with direct sources. Expand only for a named trigger and record the source, trigger, and reason.
4. Classify the task with `docs/TASK_CLASSIFICATION.md`; never downgrade a Critical trigger silently.
5. Define coordinator, one writer per file, independent verifier requirements, Gates, and validation levels.
6. Derive the smallest authorized scope, protected scope, acceptance criteria, and interruption conditions.
7. Produce the Task Packet skeleton and Task Manifest inputs. Declare transient artifacts only as regular, ignored, untracked local files; repository scripts must prove that boundary.
8. Stop for base drift, conflicting authority, material decisions, scope expansion, or unavailable independence.

Return a compact result containing `task`, `class`, `baseSha`, `delta`,
`directSources`, `expandedSources`, `scope`, `roles`, `gates`, `validation`,
`autonomy`, `interruptions`, and `taskPacketOutline`.

Before stage, preserve the machine-readable fingerprint as the approved local
reference. Require `task:fingerprint -- --verify-transition <reference.json>`
after stage and commit so the index/commit, not only the worktree, is bound to
the candidate.

Do not replace schemas, preflight, fingerprints, tests, CI, or human Gates. When
this Skill is unavailable, apply the same flow from `AGENTS.md`,
`docs/DEVELOPMENT_WORKFLOW.md`, and `docs/PROMPT_TEMPLATES.md`.
