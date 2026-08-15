# MVP09 synthetic fixture tooling

## Purpose and boundary

`fixture:synthetic` is a private, versioned process for the exact MVP09
technical-usability fixture. It creates two synthetic Organizations, three
synthetic Users with password credentials, and three Memberships; reports the
fixture state; and deactivates the complete fixture without deleting history.

The process is compiled to
`dist/database/synthetic-fixtures/cli.js`. The normal Nest application does not
import it, and it does not add an HTTP route. A built API artifact contains the
CLI so that a later, explicitly approved operation can run it as a separate
one-shot process without replacing or restarting the API.

This document does not authorize production execution. Production use requires
a later human gate with an exact release, run ID, manifest path, operator,
evidence and cleanup plan.

## Commands

Build and invoke the CLI from the repository root:

```text
npm run fixture:synthetic -- create --run-id MVP09-YYYYMMDD-8hex --manifest <absolute-external-path>.json
npm run fixture:synthetic -- status --manifest <absolute-external-path>.json
npm run fixture:synthetic -- deactivate --manifest <absolute-external-path>.json
```

The manifest path is mandatory, absolute, uses `.json`, and must remain outside
the repository. `--run-id` is accepted only by `create`. Passwords, hashes,
tokens and connection values are never CLI arguments.

The run ID must match `^MVP09-[0-9]{8}-[0-9a-f]{8}$`. Its normalized component
is the lowercase portion after `MVP09-`. For example,
`MVP09-20260815-1a2b3c4d` produces slug
`mvp09-20260815-1a2b3c4d-a` and email
`mvp09+20260815-1a2b3c4d-owner-a@example.invalid`. This avoids a duplicated
`mvp09` marker while preserving the approved formulas and existing validators.

## Database identity

The isolated CLI imports the existing migration/seed data source. Connection
selection uses `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`,
`DATABASE_MIGRATION_USER`, `DATABASE_MIGRATION_PASSWORD` and
`DATABASE_RUNTIME_ROLE`; it does not use `DATABASE_USER` or the API runtime
password. Credentials remain inputs to the existing secret wrapper and never
appear in CLI arguments, manifests or logs.

The operational identity is the approved migration owner: a distinct `LOGIN`
role that owns the database and `public` schema, has no role memberships, and
is `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`. Ownership gives
it the existing table, sequence, schema and private-function capabilities; no
new grant is required. The runtime role is intentionally insufficient because
it is not an owner and retains only functional ACLs granted by migrations. The
CLI preflight rejects superuser, RLS bypass, inheritance, role/database
creation, missing ownership or memberships. Production execution still
requires the later operational gate.

## Human credential entry

`create` requests `ownerA`, `memberA` and `ownerB` passwords through a TTY with
echo disabled. It fails closed when stdin or stdout is not an interactive TTY.
Passwords are validated and hashed with the existing Argon2id policy. They are
not accepted from environment variables, arguments or files and are not
printed, logged or written to the manifest.

The current schema stores the password credential as the User's non-selected
`password_hash`; there is no separate Credential table or credential status.
Deactivation therefore preserves the hash and makes the credential unusable by
setting the User inactive, which is already enforced by login and refresh.

## Manifest custody

The non-secret JSON manifest uses schema version `1.0.0` and contains the exact
run ID, prefix, UUIDs, roles, slugs, emails, relationships, creation timestamp
and fixture status. It contains no password, password hash, cookie, access
token, refresh token or connection material.

The temporal fields are database-backed evidence, not operator assertions.
`createdAt` is read from the common `created_at` of the two Organizations,
three Users and three Memberships inserted by the creation transaction. The
tool refuses creation if those eight persisted rows do not share that
transaction timestamp. `deactivatedAt` is the deactivation transaction's
`transaction_timestamp()` and must equal the `updated_at` persisted on all
eight rows when their statuses are changed to inactive.

PostgreSQL keeps microseconds while JavaScript `Date` and the manifest ISO
representation keep milliseconds. Every comparison therefore applies
`date_trunc('milliseconds', ...)` in PostgreSQL and compares the canonical
JavaScript `toISOString()` value. This is an explicit precision normalization,
not a tolerance window: a different millisecond is rejected.

Manifest validation always queries the database. An `active` declaration is
intact only when all Organizations, Users and Memberships are active, every
`created_at` matches `createdAt`, every `updated_at` still matches its
`created_at`, and `deactivatedAt` is null. A `deactivated` declaration is
intact only when all eight rows are inactive, every creation timestamp still
matches `createdAt`, every normalized `updated_at` matches `deactivatedAt`, and
the residual-state checks also pass. A syntactically valid replacement ISO or
status is not accepted as evidence. The manifest by itself is neither a
cryptographic signature nor a self-contained authenticity proof.

The file is published through an atomic same-directory operation, refuses a
pre-existing target, uses private permissions where supported, and is replaced
atomically during deactivation. Keep the only operational copy in a private,
operator-controlled path outside Git and outside the API container image.

The database transaction and filesystem cannot form one distributed atomic
transaction without changing the schema. The tool narrows that boundary by
writing/replacing the manifest inside the open database transaction and
restoring the previous file if commit fails. A process or host crash in the
short interval between filesystem publication and database commit is reported
as `PARTIAL` on the next inspection and requires human review; the tool never
silently adopts, repairs or overwrites that state.

## Idempotency and drift

- A second `create` is idempotent only when the existing manifest and every
  database identity, relationship, role and active status match exactly.
- `status` is read-only and returns `ACTIVE`, `PARTIAL`, `DEACTIVATED` or
  `INVALID`. It never repairs a mismatch. Temporal or status divergence is
  reported fail-closed and can never produce an intact `ACTIVE` or
  `DEACTIVATED` result.
- A second `deactivate` is idempotent only when manifest and database both
  prove the complete deactivated state.
- Missing records, formula collisions, altered manifests, extra Memberships,
  invitations, non-prefixed Leads, missing credentials or ambiguous partial
  state fail closed.

`deactivate` performs the same database-backed manifest check before opening
its mutation transaction and repeats it after acquiring the persistent row
locks. A temporal or status mismatch is rejected before Leads, Sessions,
refresh tokens, Organizations, Memberships, Users or the manifest are changed.

## Deactivation sequence

After revalidating and locking only the manifest IDs, one database transaction:

1. archives active synthetic Leads with reason `test` through the existing
   private Lead lifecycle command, which also cancels pending next actions;
2. revokes active refresh tokens and all active sessions for the three Users;
3. marks both Organizations inactive;
4. marks the three Memberships inactive, allowing existing assignment cleanup
   triggers to preserve their timeline events;
5. marks the three Users inactive;
6. verifies the final state and atomically marks the manifest `deactivated`.

The transaction preserves the domain lock order: Organizations first, then
the three Users in UUID order through the existing
`app_private.lock_auth_refresh_user` boundary, then Memberships, Sessions and
refresh tokens. Login acquires the same User lock immediately before it
revalidates active status and persists a Session/token. Thus a login that wins
is revoked by deactivation, while a deactivation that wins makes the waiting
login fail before persistence. Refresh already uses the same User-to-Session
lock order.

A repeated `deactivate` may recover only an exact manifest-bound residual after
the deactivated manifest, inactive fixture rows and both persisted timestamps
remain mutually consistent: synthetic Leads and Sessions/tokens belonging to
the three exact Users. It relocks and revokes these residual rows before final
verification without changing the original deactivation evidence. External
Membership, invitation, non-synthetic Lead, entity-status drift,
identity/formula drift or altered manifest remains non-recoverable and is never
repaired.

Making Organizations inactive before Memberships and Users preserves the
deferred effective-owner invariant. Terminal Leads that were already won, lost
or archived remain immutable historical records and are neutralized by the
inactive Organization. No row is hard-deleted.

Archiving active Leads reuses the configured `LEAD_IDEMPOTENCY_KEYS` and
`LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION`. Their values are consumed by the
process but never printed. If active Leads exist and the keyring is unavailable,
deactivation fails before changing data.

## Prohibitions

The CLI does not create endpoints, send invitations or email, run migrations,
change schema, deploy code, restart the API, operate on identities outside the
manifest, accept real data, overwrite credentials, repair drift, execute hard
delete or print secret-bearing objects. Do not run it against production until
the later operational gate explicitly authorizes the exact candidate and
fixture.
