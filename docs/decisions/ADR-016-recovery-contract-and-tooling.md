# ADR-016 — Recovery contract and tooling

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

The MVP needs recoverable external backups before real data, while the current phase forbids production mutation and credentials in development artifacts. Upload completion alone does not prove recovery, PostgreSQL RLS can silently produce partial logical dumps, and restore testing must never target the active volume.

## Decision

Use PostgreSQL 17 custom-format logical dumps with moderate zstd compression and an explicit lock wait timeout. A dedicated backup credential must prove `BYPASSRLS` or superuser and `SELECT` on every application table. Encrypt the dump with age before rclone transports it to the dedicated Google Drive account. Verify by downloading through the recovery route, comparing ciphertext SHA-256, and restoring from that download.

Schedule every 12 hours with systemd, warn at 18 hours, declare critical at 24 hours, and create checkpoint backups before approved changes. Retain regular and checkpoint backups by age for 30 and 90 days respectively while protecting at least two verified copies. Drive cleanup moves exact revalidated object IDs to trash and never purges permanently.

Every restore proof uses a run-labeled internal network, an isolated PostgreSQL 17 volume, zero published ports, `pg_restore --exit-on-error`, schema/migration/RLS/ACL checks, and an ephemeral pinned API health/readiness smoke. The active `genesis-postgres-data` volume is denied.

Tools use official versioned linux/amd64 archives with fixed public SHA-256 values. Secrets remain referenced root-only files outside Git and the release bundle. Production may use only a validated committed-release bundle incorporated into `main`.

## Alternatives considered

- Physical volume copies were rejected because the approved first contract is portable logical recovery.
- PITR/WAL was deferred beyond the MVP scope.
- Upload-only verification was rejected because it does not prove the recovery route or restore.
- A general remote-operator platform was rejected as unnecessary for the bounded Window R.
- Permanent Drive deletion was rejected; trash preserves recoverability.

## Consequences

The contract meets a 24-hour business RPO with a 12-hour schedule and defines a four-hour synthetic logical RTO, but it does not provide point-in-time or public-service recovery. Operations still require a separately approved credential/production gate and 07B. External alerting remains deferred to `0.8-MVP-09`; local machine-readable status is part of 07.

## Relations and implementation

This ADR specializes ADR-013 and ADR-014. The implementation is versioned by `config/recovery/backup-restore.v1.json`, the future operational envelope by `config/recovery/window-r-plan.v1.json`, and the procedure by `docs/RECOVERY_RUNBOOK.md`.
