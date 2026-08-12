# Recovery runbook

<!-- genesis-memory-authority:v1 path=docs/memory/project-state.v1.json -->

## Status and boundary

The `0.8-MVP-07A.v1` recovery contract is incorporated tooling, not an active backup service. It prepares the future `0.8-MVP-07B` Window R. This document does not authorize production access, Google OAuth, Drive mutation, definitive age-key generation, systemd activation, real backup/restore, active-volume access, or real data.

The authoritative machine-readable files are:

- `config/recovery/backup-restore.v1.json` for the backup and restore contract;
- `config/recovery/window-r-plan.v1.json` for allowed Window R actions, exact paths, resources, preconditions, attempts, stop conditions, rollback, and credential references;
- `release-manifest.json` in a validated `committed-release` bundle for operational provenance.

Candidate bundles are non-operational. Window R must consume bytes from a commit incorporated into `main` and revalidate its committed-release bundle before any host change.

## Required future credential gate

The future gate supplies references, never values, for a root-only PostgreSQL backup pgpass, a public age recipient, a separately custodied age identity, a root-only rclone config, and synthetic restore secrets. The age identity must not be generated before its approved custody procedure. OAuth starts with `drive.file` on the dedicated `admreserva433@gmail.com` account. Fallback to `drive` is allowed only when the account is confirmed dedicated and empty and a new credential gate approves it. `root_folder_id` protects paths operationally; it is not an authorization boundary.

## Backup pipeline

`genesis-backup.service` invokes `backup-runner.sh` under a non-blocking `flock`; the timer schedules 00:15 and 12:15 UTC with jitter and persistence. The runner:

1. validates exact nonsecret and root-only secret paths;
2. proves the backup role is superuser or `BYPASSRLS` and has `SELECT` on every application table; a role limited by RLS fails closed;
3. runs PostgreSQL 17 `pg_dump --format=custom --compress=zstd:6 --lock-wait-timeout=60s` without `--enable-row-security`;
4. fails on nonzero exit, empty archive, or any diagnostic output;
5. keeps the plaintext dump root-only and temporary;
6. encrypts to a ciphertext `.partial`, computes only its SHA-256, and atomically renames it;
7. uploads with an immutable unique name and captures remote path, object ID, size, and available metadata;
8. downloads through the recovery route, compares ciphertext SHA-256, and creates an immutable verification marker;
9. applies age-based retention while protecting the newest two verified copies;
10. writes an atomic local JSON status and removes local plaintext/download temporaries.

`--mode checkpoint` is required before an approved change; checkpoints retain 90 days, regular backups 30. Drive deletions use trash. The retention runner revalidates exact path and object ID immediately before deleting the marker and ciphertext. Permanent purge has no supported action.

## Isolated restore proof

The production restore proof accepts an exact remote path, object ID and expected ciphertext SHA-256, revalidates the remote identity, downloads it to a `.partial`, then restores that downloaded object. A local ciphertext input exists only for isolated synthetic testing. The runner never selects or touches `genesis-postgres-data`. Each run creates only names prefixed with its 16-hex run ID and label `com.genesis.recovery.run=<id>`:

- one internal Docker network;
- one isolated PostgreSQL 17 volume;
- one PostgreSQL 17 container;
- one ephemeral API container;
- transient one-shot restore and verification containers.

No resource publishes a port. After SHA-256 comparison, age decrypts into a root-only temporary archive. `pg_restore --exit-on-error --no-owner --role genesis_migration` connects through the bootstrap credential but creates restored objects under the production migration role. The runner verifies that `genesis_migration` owns the database, `public` schema, application tables, partitions, and sequences; it also checks the migrations table, application tables, RLS policy coverage, and runtime `SELECT` ACLs. It then starts the pinned API image exclusively on the internal restore network. Both `/api/v1/health/live` and `/api/v1/health/ready` must return `status=ok`. Cleanup inspects the exact resource label before removing only run-owned containers, volume, and network.

The four-hour logical RTO starts when a backup and recovery credential are available and ends when PostgreSQL health plus API readiness/smoke pass. It is not public-service recovery.

## Status and diagnosis

Atomic JSON status files live under `/var/lib/genesis/recovery/status`. `check-status.sh` returns 0 before 18 hours, 1 from 18 hours, and 2 at 24 hours or on failure/missing status. External alerting is deferred to `0.8-MVP-09`.

On any backup failure, preserve the service journal and status metadata but never print a secret, OAuth config, private identity, plaintext dump, or plaintext hash. Do not retry beyond the plan limits. On checksum, RLS, restore, API readiness, release identity, Docker resource, scope, or active-volume failure, stop Window R and apply only the action-specific rollback in the plan.

## Installation and activation sequence for 07B

Only after the credential/production gate:

1. verify all Window R preconditions and the committed-release source commit;
2. run `install-pinned-tools.sh`; it downloads only official versioned archives and verifies their fixed public SHA-256 values before installation under `/opt/genesis/recovery/bin`;
3. install configuration, directories, references, and inactive systemd unit files at exact declared paths;
4. run synthetic preflight, one checkpoint backup, remote round trip, and isolated restore proof;
5. inspect machine-readable status and confirm zero published restore ports and no active-volume reference;
6. only then enable/start the timer once, without restarting API, PostgreSQL, or Traefik;
7. capture Window R evidence and stop. Gate 3 for 07B remains separate.

Never use `latest`, `curl | sh`, `docker compose down -v`, Drive purge, a candidate bundle, a mutable binary, or an unverified download.
