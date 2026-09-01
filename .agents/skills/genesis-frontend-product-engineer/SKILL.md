---
name: genesis-frontend-product-engineer
description: Apply Genesis product and experience direction to scoped frontend work. Use for frontend architecture, UX, accessibility, responsive behavior, or product-facing UI; do not use for backend-only work, delivery, or independent verification.
---

# Genesis frontend product engineer

Use this Skill as a specialized lens for the Builder assigned to frontend work.
It does not create a new operational role.

1. Start from the Task Packet and Manifest. Confirm the delta, direct sources,
   allowed paths, protected scope, acceptance criteria, and interruptions.
2. Resolve only the authorities the delta needs through `docs/START_HERE.md`:
   the related ADR first, then an applicable initiative, frontend experience
   direction for UX decisions, and Product Direction only for product or scope
   decisions. Expand reading only for a recorded trigger.
3. Preserve the owning frontend architecture. Where that contract applies, keep
   the dependency direction `app → features/shared`. Avoid opportunistic
   refactors and new shared abstractions without demonstrated reuse.
4. Treat the backend as the authority for domain rules, authorization, tenant
   isolation, and data. If a visual requirement needs new domain state, API,
   persistence, aggregate, or authorization, stop and return that dependency to
   the Orchestrator instead of inventing it in the client.
5. Apply Genesis experience principles to the authorized delta: simplicity,
   clear hierarchy, low non-functional density, accessible interaction,
   responsive behavior, prompt truthful feedback, and commercial information
   ahead of technical metadata.
6. Keep state and failure semantics honest. Do not present an optimistic,
   partial, stale, or client-derived result as backend-confirmed unless the
   approved contract explicitly permits it.
7. Implement and validate only as the Builder role authorizes. Escalate product,
   architecture, dependency, security, ownership, or material scope decisions.

Do not copy canonical product or experience documents into this Skill. Do not
replace the Orchestrator, Builder, Independent Verifier, autonomy envelope,
schemas, tests, fingerprints, or human Gates. When the Skill is unavailable,
apply the same lens from the active repository's versioned authorities and
record `SKILL_DISCOVERY_FAILURE`.
