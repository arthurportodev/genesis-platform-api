#!/usr/bin/env python3
"""Fail-closed Genesis API production release operator.

The public commands are intentionally small:

* prepare creates deterministic, allowlisted transport archives;
* preflight proves the immutable plan and observed baseline without mutation;
* execute repeats preflight while holding a lock and crosses the mutation
  boundary only when every independent authorization factor is present.

The module is standard-library only.  Its small pure functions are also the
test seam: production uses ``SystemRuntime`` while tests inject a fake runtime
and clock.  No exception text or subprocess output is written to evidence.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.cookiejar
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping, Protocol, Sequence

try:
    import fcntl
except ImportError:  # pragma: no cover - production and Linux CI require fcntl.
    fcntl = None  # type: ignore[assignment]


SCHEMA_VERSION = "genesis-api-deployment-plan.v1"
RUN_ID_RE = re.compile(r"^[0-9a-f]{16}$")
AUTH_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
GIT_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
IMAGE_RE = re.compile(r"^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$")
FINGERPRINT_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
SSH_ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
MIGRATION_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,127}[0-9]{10,20}$")
SAFE_ABSOLUTE_RE = re.compile(r"^/[A-Za-z0-9._/-]+$")
OBSERVATION_SECONDS = 900
OBSERVATION_CHECKPOINTS = (0, 120, 300, 600, 900)
SENSITIVE_WORDS = re.compile(
    r"password|passwd|secret|token|cookie|authorization|credential|set-cookie",
    re.IGNORECASE,
)


class StopBeforeMutation(RuntimeError):
    """A contract mismatch that must stop before the mutation boundary."""


class EscalationRequired(RuntimeError):
    """A partial state for which speculative repair is forbidden."""


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise StopBeforeMutation("INVALID_JSON") from exc


def require_exact_keys(value: Mapping[str, Any], keys: set[str], label: str) -> None:
    if set(value) != keys:
        raise StopBeforeMutation(f"INVALID_{label.upper()}_FIELDS")


def require_string(value: Any, pattern: re.Pattern[str], code: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise StopBeforeMutation(code)
    return value


def require_absolute(value: Any, code: str) -> str:
    result = require_string(value, SAFE_ABSOLUTE_RE, code)
    if "//" in result or "/../" in f"{result}/" or result.endswith("/.."):
        raise StopBeforeMutation(code)
    return result


def validate_plan(plan: Any) -> dict[str, Any]:
    """Validate the complete non-secret deployment plan, without defaults."""
    if not isinstance(plan, dict):
        raise StopBeforeMutation("INVALID_PLAN")
    require_exact_keys(
        plan,
        {
            "schemaVersion",
            "runId",
            "authorizationId",
            "sourceCommit",
            "host",
            "paths",
            "candidate",
            "rollback",
            "baseline",
            "migrations",
            "secrets",
            "smoke",
            "observation",
            "minimumFreeBytes",
        },
        "plan",
    )
    if plan["schemaVersion"] != SCHEMA_VERSION:
        raise StopBeforeMutation("INVALID_PLAN_SCHEMA")
    require_string(plan["runId"], RUN_ID_RE, "INVALID_RUN_ID")
    require_string(plan["authorizationId"], AUTH_ID_RE, "INVALID_AUTHORIZATION_ID")
    require_string(plan["sourceCommit"], GIT_SHA_RE, "INVALID_SOURCE_COMMIT")

    host = plan["host"]
    if not isinstance(host, dict):
        raise StopBeforeMutation("INVALID_HOST")
    require_exact_keys(
        host,
        {"sshAlias", "hostname", "architecture", "knownHostsFile", "identityFile", "hostKeyFingerprint"},
        "host",
    )
    require_string(host["sshAlias"], SSH_ALIAS_RE, "INVALID_SSH_ALIAS")
    if host["hostname"] != "srv1870064" or host["architecture"] != "linux/amd64":
        raise StopBeforeMutation("UNAPPROVED_HOST")
    require_absolute(host["knownHostsFile"], "INVALID_KNOWN_HOSTS_PATH")
    require_absolute(host["identityFile"], "INVALID_IDENTITY_PATH")
    require_string(host["hostKeyFingerprint"], re.compile(r"^SHA256:[A-Za-z0-9+/]{20,64}$"), "INVALID_HOST_KEY_FINGERPRINT")

    paths = plan["paths"]
    if not isinstance(paths, dict):
        raise StopBeforeMutation("INVALID_PATHS")
    require_exact_keys(paths, {"activeRelease", "remoteWorkspace", "deploymentLock", "allowedExistingSiblings"}, "paths")
    if require_absolute(paths["activeRelease"], "INVALID_ACTIVE_PATH") != "/opt/genesis/release":
        raise StopBeforeMutation("UNAPPROVED_ACTIVE_PATH")
    workspace = require_absolute(paths["remoteWorkspace"], "INVALID_WORKSPACE_PATH")
    if not workspace.startswith("/run/genesis-api-deploy-") or not workspace.endswith(plan["runId"]):
        raise StopBeforeMutation("UNAPPROVED_WORKSPACE_PATH")
    if require_absolute(paths["deploymentLock"], "INVALID_LOCK_PATH") != "/run/lock/genesis-api-deployment.lock":
        raise StopBeforeMutation("UNAPPROVED_LOCK_PATH")
    siblings = paths["allowedExistingSiblings"]
    if not isinstance(siblings, list) or len(set(siblings)) != len(siblings):
        raise StopBeforeMutation("INVALID_ALLOWED_SIBLINGS")
    for sibling in siblings:
        require_string(sibling, re.compile(r"^\.genesis-release-(?:rollback|quarantine)-[A-Za-z0-9._-]{1,96}$"), "INVALID_ALLOWED_SIBLING")

    for label in ("candidate", "rollback"):
        release = plan[label]
        if not isinstance(release, dict):
            raise StopBeforeMutation(f"INVALID_{label.upper()}")
        require_exact_keys(release, {"image", "bundleFingerprint"}, label)
        require_string(release["image"], IMAGE_RE, f"INVALID_{label.upper()}_IMAGE")
        require_string(release["bundleFingerprint"], FINGERPRINT_RE, f"INVALID_{label.upper()}_FINGERPRINT")
    if plan["candidate"]["image"] == plan["rollback"]["image"]:
        raise StopBeforeMutation("RELEASE_IMAGES_NOT_DISTINCT")
    if plan["candidate"]["bundleFingerprint"] == plan["rollback"]["bundleFingerprint"]:
        raise StopBeforeMutation("RELEASE_FINGERPRINTS_NOT_DISTINCT")

    baseline = plan["baseline"]
    if not isinstance(baseline, dict):
        raise StopBeforeMutation("INVALID_BASELINE")
    require_exact_keys(
        baseline,
        {"activeBundleFingerprint", "liveImage", "volume", "project", "apiContainer", "postgresContainer", "traefikContainer"},
        "baseline",
    )
    require_string(baseline["activeBundleFingerprint"], FINGERPRINT_RE, "INVALID_BASELINE_FINGERPRINT")
    require_string(baseline["liveImage"], IMAGE_RE, "INVALID_BASELINE_IMAGE")
    if baseline["liveImage"] != plan["rollback"]["image"]:
        raise StopBeforeMutation("ROLLBACK_DOES_NOT_MATCH_BASELINE")
    if baseline["volume"] != "genesis-postgres-data" or baseline["project"] != "genesis":
        raise StopBeforeMutation("INVALID_COMPOSE_IDENTITY")
    for key in ("apiContainer", "postgresContainer", "traefikContainer"):
        require_string(baseline[key], re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$"), "INVALID_CONTAINER_NAME")

    migrations = plan["migrations"]
    if not isinstance(migrations, dict):
        raise StopBeforeMutation("INVALID_MIGRATIONS")
    require_exact_keys(
        migrations,
        {"database", "bootstrapUser", "appliedBefore", "pending", "postHead", "applicationRollbackCompatible"},
        "migrations",
    )
    for key in ("database", "bootstrapUser"):
        require_string(migrations[key], re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$"), "INVALID_DATABASE_IDENTITY")
    before, pending = migrations["appliedBefore"], migrations["pending"]
    if not isinstance(before, list) or not isinstance(pending, list) or not pending:
        raise StopBeforeMutation("INVALID_MIGRATION_SETS")
    for migration in before + pending:
        require_string(migration, MIGRATION_RE, "INVALID_MIGRATION_ID")
    if len(set(before + pending)) != len(before) + len(pending):
        raise StopBeforeMutation("DUPLICATE_MIGRATION_ID")
    if migrations["postHead"] != pending[-1] or migrations["applicationRollbackCompatible"] is not True:
        raise StopBeforeMutation("INVALID_MIGRATION_ROLLBACK_CONTRACT")

    secrets = plan["secrets"]
    if not isinstance(secrets, list) or not secrets:
        raise StopBeforeMutation("INVALID_SECRET_REFERENCES")
    seen_secret_paths: set[str] = set()
    secret_purposes: list[str] = []
    for secret in secrets:
        if not isinstance(secret, dict):
            raise StopBeforeMutation("INVALID_SECRET_REFERENCE")
        require_exact_keys(secret, {"purpose", "path", "uid", "gid", "mode"}, "secret")
        if secret["purpose"] not in {"compose", "registry", "smoke"}:
            raise StopBeforeMutation("INVALID_SECRET_PURPOSE")
        secret_purposes.append(secret["purpose"])
        secret_path = require_absolute(secret["path"], "INVALID_SECRET_PATH")
        if not secret_path.startswith("/opt/genesis/secrets/") or secret_path in seen_secret_paths:
            raise StopBeforeMutation("UNAPPROVED_SECRET_PATH")
        seen_secret_paths.add(secret_path)
        if secret["uid"] != 0 or not isinstance(secret["gid"], int) or secret["gid"] < 0 or secret["mode"] not in {"0400", "0440", "0600", "0640"}:
            raise StopBeforeMutation("INVALID_SECRET_METADATA")
    if secret_purposes.count("registry") != 1 or secret_purposes.count("smoke") != 1 or "compose" not in secret_purposes:
        raise StopBeforeMutation("INVALID_SECRET_PURPOSE_SET")

    smoke = plan["smoke"]
    if not isinstance(smoke, dict):
        raise StopBeforeMutation("INVALID_SMOKE")
    require_exact_keys(smoke, {"baseUrl", "credentialsFile", "tenantProbePath", "kanbanPath", "financialAssertions"}, "smoke")
    parsed_url = urllib.parse.urlparse(smoke["baseUrl"] if isinstance(smoke["baseUrl"], str) else "")
    if parsed_url.scheme != "https" or not parsed_url.hostname or parsed_url.path not in {"", "/"}:
        raise StopBeforeMutation("INVALID_SMOKE_URL")
    require_absolute(smoke["credentialsFile"], "INVALID_SMOKE_CREDENTIALS_PATH")
    if smoke["credentialsFile"] not in seen_secret_paths:
        raise StopBeforeMutation("UNDECLARED_SMOKE_CREDENTIALS")
    if smoke["tenantProbePath"] != "/api/v1/auth/bootstrap" or smoke["kanbanPath"] != "/api/v1/leads/kanban?limit=20":
        raise StopBeforeMutation("INVALID_SMOKE_PATHS")
    assertions = smoke["financialAssertions"]
    if assertions != {
        "currency": "BRL",
        "expectedValueTotalMinor": "decimal-string",
        "withoutExpectedValue": "integer",
        "stageAggregates": True,
        "cardExpectedValueMinor": "decimal-string-or-null",
    }:
        raise StopBeforeMutation("INVALID_FINANCIAL_ASSERTIONS")

    observation = plan["observation"]
    if not isinstance(observation, dict):
        raise StopBeforeMutation("INVALID_OBSERVATION")
    require_exact_keys(observation, {"durationSeconds", "checkpointsSeconds"}, "observation")
    if observation["durationSeconds"] != OBSERVATION_SECONDS or observation["checkpointsSeconds"] != list(OBSERVATION_CHECKPOINTS):
        raise StopBeforeMutation("INVALID_OBSERVATION_WINDOW")
    if not isinstance(plan["minimumFreeBytes"], int) or plan["minimumFreeBytes"] < 256 * 1024 * 1024:
        raise StopBeforeMutation("INVALID_DISK_GATE")
    return plan


def plan_sha(plan_path: Path) -> str:
    # The approval binds the exact bytes presented to the human, not a rewrite.
    return sha256_file(plan_path)


def load_bundle_manifest(bundle: Path, expected_fingerprint: str, role: str, image: str, source_commit: str) -> dict[str, Any]:
    manifest_path = bundle / "release-manifest.json"
    if bundle.is_symlink() or not bundle.is_dir() or not manifest_path.is_file() or manifest_path.is_symlink():
        raise StopBeforeMutation("MISSING_BUNDLE")
    raw = manifest_path.read_bytes()
    if f"sha256:{sha256_bytes(raw)}" != expected_fingerprint:
        raise StopBeforeMutation("BUNDLE_FINGERPRINT_MISMATCH")
    manifest = load_json(manifest_path)
    if not isinstance(manifest, dict):
        raise StopBeforeMutation("INVALID_BUNDLE_MANIFEST")
    if manifest.get("bundleMode") != "committed-release" or manifest.get("operational") is not True:
        raise StopBeforeMutation("NON_OPERATIONAL_BUNDLE")
    if manifest.get("releaseRole") != role or manifest.get("sourceCommit") != source_commit:
        raise StopBeforeMutation("BUNDLE_IDENTITY_MISMATCH")
    if manifest.get("images", {}).get("api", {}).get("reference") != image:
        raise StopBeforeMutation("BUNDLE_IMAGE_MISMATCH")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise StopBeforeMutation("INVALID_BUNDLE_ARTIFACTS")
    expected_paths = {"release-manifest.json"}
    for entry in artifacts:
        if not isinstance(entry, dict):
            raise StopBeforeMutation("INVALID_BUNDLE_ARTIFACT")
        relative = entry.get("path")
        if not isinstance(relative, str) or not is_safe_relative(relative):
            raise StopBeforeMutation("UNSAFE_BUNDLE_PATH")
        if relative in expected_paths:
            raise StopBeforeMutation("DUPLICATE_BUNDLE_PATH")
        expected_paths.add(relative)
        path = bundle / PurePosixPath(relative)
        if not path.is_file() or path.is_symlink():
            raise StopBeforeMutation("UNSAFE_BUNDLE_ARTIFACT")
        if entry.get("sha256") != sha256_file(path):
            raise StopBeforeMutation("BUNDLE_ARTIFACT_HASH_MISMATCH")
        if os.name != "nt" and entry.get("mode") != f"{stat.S_IMODE(path.stat().st_mode):04o}":
            raise StopBeforeMutation("BUNDLE_ARTIFACT_MODE_MISMATCH")
    actual = {
        item.relative_to(bundle).as_posix()
        for item in bundle.rglob("*")
        if item.is_file()
    }
    if actual != expected_paths:
        raise StopBeforeMutation("BUNDLE_FILE_SET_MISMATCH")
    return manifest


def is_safe_relative(value: str) -> bool:
    path = PurePosixPath(value)
    return bool(value) and not path.is_absolute() and ".." not in path.parts and "\\" not in value and str(path) == value


def validate_bundle_pair(current: Path, rollback: Path, plan: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    current_manifest = load_bundle_manifest(
        current,
        plan["candidate"]["bundleFingerprint"],
        "current",
        plan["candidate"]["image"],
        plan["sourceCommit"],
    )
    rollback_manifest = load_bundle_manifest(
        rollback,
        plan["rollback"]["bundleFingerprint"],
        "rollback",
        plan["rollback"]["image"],
        plan["sourceCommit"],
    )
    expected_migrations = plan["migrations"]["appliedBefore"] + plan["migrations"]["pending"]
    migration_contract = {
        "sourcePath": "src/database/migrations",
        "orderedNames": expected_migrations,
    }
    if current_manifest.get("migrations") != migration_contract:
        raise StopBeforeMutation("CANDIDATE_MIGRATION_SET_MISMATCH")
    if rollback_manifest.get("migrations") != migration_contract:
        raise StopBeforeMutation("ROLLBACK_MIGRATION_SET_MISMATCH")
    current_paths = {entry["path"] for entry in current_manifest["artifacts"]}
    rollback_paths = {entry["path"] for entry in rollback_manifest["artifacts"]}
    if current_paths != rollback_paths:
        raise StopBeforeMutation("BUNDLE_PAIR_FILE_SET_MISMATCH")
    for relative in current_paths - {"compose.production.yml"}:
        if (current / PurePosixPath(relative)).read_bytes() != (rollback / PurePosixPath(relative)).read_bytes():
            raise StopBeforeMutation("BUNDLE_PAIR_CONTENT_MISMATCH")
    current_compose = (current / "compose.production.yml").read_bytes()
    rollback_compose = (rollback / "compose.production.yml").read_bytes()
    current_image = plan["candidate"]["image"].encode()
    rollback_image = plan["rollback"]["image"].encode()
    if current_compose.count(current_image) != 2 or rollback_compose != current_compose.replace(current_image, rollback_image):
        raise StopBeforeMutation("BUNDLE_PAIR_DERIVATION_MISMATCH")
    if "docker/production/deploy-api-release.py" not in current_paths:
        raise StopBeforeMutation("VERSIONED_OPERATOR_MISSING")
    operator_entry = next(
        entry for entry in current_manifest["artifacts"]
        if entry["path"] == "docker/production/deploy-api-release.py"
    )
    if sha256_file(Path(__file__).resolve()) != operator_entry["sha256"]:
        raise StopBeforeMutation("RUNNING_OPERATOR_NOT_BUNDLE_BOUND")
    return current_manifest, rollback_manifest


def deterministic_archive(bundle: Path, manifest: Mapping[str, Any], output: Path) -> str:
    """Create a byte-stable archive containing only manifest-allowlisted files."""
    output.parent.mkdir(parents=True, exist_ok=True)
    modes = {entry["path"]: int(entry["mode"], 8) for entry in manifest["artifacts"]}
    modes["release-manifest.json"] = 0o644
    allowed = ["release-manifest.json"] + sorted(entry["path"] for entry in manifest["artifacts"])
    directories = sorted({str(parent) for name in allowed for parent in PurePosixPath(name).parents if str(parent) != "."})
    with tarfile.open(output, "w", format=tarfile.GNU_FORMAT) as archive:
        for directory in directories:
            info = tarfile.TarInfo(directory)
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mtime = 0
            archive.addfile(info)
        for relative in allowed:
            source = bundle / PurePosixPath(relative)
            if not source.is_file() or source.is_symlink():
                raise StopBeforeMutation("UNSAFE_ARCHIVE_SOURCE")
            info = tarfile.TarInfo(relative)
            info.size = source.stat().st_size
            info.mode = modes[relative]
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mtime = 0
            with source.open("rb") as handle:
                archive.addfile(info, handle)
    return sha256_file(output)


def safe_extract(archive_path: Path, destination: Path, allowed_files: set[str]) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive_path, "r:") as archive:
        members = archive.getmembers()
        actual_files: set[str] = set()
        for member in members:
            if not is_safe_relative(member.name):
                raise StopBeforeMutation("UNSAFE_ARCHIVE_PATH")
            if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                raise StopBeforeMutation("UNSAFE_ARCHIVE_TYPE")
            if member.isfile():
                actual_files.add(member.name)
                if member.name not in allowed_files:
                    raise StopBeforeMutation("ARCHIVE_FILE_NOT_ALLOWLISTED")
            elif not member.isdir():
                raise StopBeforeMutation("UNSAFE_ARCHIVE_TYPE")
        if actual_files != allowed_files:
            raise StopBeforeMutation("ARCHIVE_FILE_SET_MISMATCH")
        archive.extractall(destination, filter="data")


def archive_allowlist(archive_path: Path) -> set[str]:
    """Read only the manifest after first proving every tar member is benign."""
    with tarfile.open(archive_path, "r:") as archive:
        members = archive.getmembers()
        for member in members:
            if not is_safe_relative(member.name) or member.issym() or member.islnk() or member.isdev() or member.isfifo():
                raise StopBeforeMutation("UNSAFE_ARCHIVE_MEMBER")
        manifest_member = next((member for member in members if member.name == "release-manifest.json" and member.isfile()), None)
        if manifest_member is None or manifest_member.size > 1024 * 1024:
            raise StopBeforeMutation("ARCHIVE_MANIFEST_MISSING")
        handle = archive.extractfile(manifest_member)
        if handle is None:
            raise StopBeforeMutation("ARCHIVE_MANIFEST_MISSING")
        try:
            manifest = json.loads(handle.read())
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise StopBeforeMutation("ARCHIVE_MANIFEST_INVALID") from exc
    artifacts = manifest.get("artifacts") if isinstance(manifest, dict) else None
    if not isinstance(artifacts, list):
        raise StopBeforeMutation("ARCHIVE_MANIFEST_INVALID")
    paths = {entry.get("path") for entry in artifacts if isinstance(entry, dict)}
    if None in paths or any(not isinstance(path, str) or not is_safe_relative(path) for path in paths):
        raise StopBeforeMutation("ARCHIVE_MANIFEST_INVALID")
    return {"release-manifest.json", *paths}


def materialize_transport(transport: Path, output: Path, plan: Mapping[str, Any], approved_sha: str) -> tuple[Path, Path]:
    """Verify a transferred envelope and safely materialize its two bundles."""
    names = {
        "current.tar", "rollback.tar", "deployment-plan.json",
        "deploy-api-release.py", "transfer-manifest.json",
    }
    if not transport.is_dir() or {path.name for path in transport.iterdir() if path.is_file()} != names:
        raise StopBeforeMutation("TRANSFER_FILE_SET_MISMATCH")
    if any((transport / name).is_symlink() for name in names):
        raise StopBeforeMutation("UNSAFE_TRANSFER_FILE")
    manifest = load_json(transport / "transfer-manifest.json")
    if not isinstance(manifest, dict):
        raise StopBeforeMutation("INVALID_TRANSFER_MANIFEST")
    require_exact_keys(manifest, {"schemaVersion", "runId", "approvedPlanSha256", "files"}, "transfer_manifest")
    if manifest["schemaVersion"] != "genesis-api-deployment-transfer.v1" or manifest["runId"] != plan["runId"] or manifest["approvedPlanSha256"] != approved_sha:
        raise StopBeforeMutation("TRANSFER_IDENTITY_MISMATCH")
    expected_paths = {"current.tar", "rollback.tar", "deployment-plan.json", "deploy-api-release.py"}
    entries = manifest["files"]
    if not isinstance(entries, list) or {entry.get("path") for entry in entries if isinstance(entry, dict)} != expected_paths:
        raise StopBeforeMutation("TRANSFER_MANIFEST_FILE_SET_MISMATCH")
    for entry in entries:
        require_exact_keys(entry, {"path", "sha256", "mode"}, "transfer_file")
        path = transport / entry["path"]
        require_string(entry["sha256"], SHA_RE, "INVALID_TRANSFER_HASH")
        if sha256_file(path) != entry["sha256"]:
            raise StopBeforeMutation("TRANSFER_HASH_MISMATCH")
        if entry["mode"] not in {"0600", "0700"}:
            raise StopBeforeMutation("INVALID_TRANSFER_MODE")
        if os.name != "nt" and f"{stat.S_IMODE(path.stat().st_mode):04o}" != entry["mode"]:
            raise StopBeforeMutation("TRANSFER_MODE_MISMATCH")
    if sha256_file(transport / "deployment-plan.json") != approved_sha:
        raise StopBeforeMutation("TRANSFER_PLAN_SHA_MISMATCH")
    output.mkdir(parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    current, rollback = output / "current", output / "rollback"
    safe_extract(transport / "current.tar", current, archive_allowlist(transport / "current.tar"))
    safe_extract(transport / "rollback.tar", rollback, archive_allowlist(transport / "rollback.tar"))
    current_manifest, _ = validate_bundle_pair(current, rollback, plan)
    operator_entry = next(
        entry for entry in current_manifest["artifacts"]
        if entry["path"] == "docker/production/deploy-api-release.py"
    )
    if sha256_file(transport / "deploy-api-release.py") != operator_entry["sha256"]:
        raise StopBeforeMutation("TRANSFERRED_OPERATOR_MISMATCH")
    return current, rollback


@dataclass(frozen=True)
class EvidenceContext:
    run_id: str
    authorization_id: str
    approved_plan_sha: str
    source_commit: str
    candidate_image: str
    rollback_image: str
    candidate_fingerprint: str
    rollback_fingerprint: str


class Evidence:
    ALLOWED_EVIDENCE_FIELDS = {
        "checkpointSeconds",
        "migrationCount",
        "archiveSha256",
        "role",
        "state",
        "reasonCode",
    }

    def __init__(self, path: Path, context: EvidenceContext, now: Callable[[], float] = time.time):
        self.path = path
        self.context = context
        self.now = now

    def emit(self, phase: str, result: str, **details: Any) -> None:
        if set(details) - self.ALLOWED_EVIDENCE_FIELDS:
            raise StopBeforeMutation("UNSAFE_EVIDENCE_FIELD")
        for key, value in details.items():
            if SENSITIVE_WORDS.search(key) or SENSITIVE_WORDS.search(str(value)):
                raise StopBeforeMutation("EVIDENCE_LEAK_REJECTED")
        record = {
            "timestamp": datetime.fromtimestamp(self.now(), timezone.utc).isoformat().replace("+00:00", "Z"),
            "runId": self.context.run_id,
            "authorizationId": self.context.authorization_id,
            "approvedPlanSha256": self.context.approved_plan_sha,
            "sourceCommit": self.context.source_commit,
            "candidateImage": self.context.candidate_image,
            "rollbackImage": self.context.rollback_image,
            "candidateBundleFingerprint": self.context.candidate_fingerprint,
            "rollbackBundleFingerprint": self.context.rollback_fingerprint,
            "phase": phase,
            "result": result,
            **details,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("ab") as handle:
            handle.write(canonical_json(record))


def make_evidence(plan: Mapping[str, Any], approved_sha: str, path: Path, now: Callable[[], float] = time.time) -> Evidence:
    return Evidence(
        path,
        EvidenceContext(
            plan["runId"],
            plan["authorizationId"],
            approved_sha,
            plan["sourceCommit"],
            plan["candidate"]["image"],
            plan["rollback"]["image"],
            plan["candidate"]["bundleFingerprint"],
            plan["rollback"]["bundleFingerprint"],
        ),
        now,
    )


class Runtime(Protocol):
    mutations: list[str]

    def verify_pair(self, plan: Mapping[str, Any], current: Path, rollback: Path) -> None: ...
    def verify_active(self, plan: Mapping[str, Any], fingerprint: str, image: str, role: str = "current") -> None: ...
    def snapshot(self, plan: Mapping[str, Any], release_root: Path) -> Mapping[str, Any]: ...
    def registry_pull(self, plan: Mapping[str, Any]) -> None: ...
    def migrate(self, plan: Mapping[str, Any], release_root: Path) -> None: ...
    def activate(self, plan: Mapping[str, Any], current: Path, rollback: Path) -> None: ...
    def recreate_api(self, plan: Mapping[str, Any], release_root: Path) -> None: ...
    def smoke(self, plan: Mapping[str, Any], minimal: bool = False) -> None: ...
    def observe(self, plan: Mapping[str, Any]) -> None: ...
    def rollback(self, plan: Mapping[str, Any]) -> None: ...


def validate_snapshot(
    plan: Mapping[str, Any],
    observed: Mapping[str, Any],
    *,
    allow_candidate: bool = False,
    deployment_lock_owned: bool = False,
) -> str:
    """Compare a read-only snapshot with the exact approved baseline."""
    required = {
        "hostname", "architecture", "activeFingerprint", "apiImage", "apiState", "apiHealth",
        "apiRestarts", "postgresId", "postgresHealth", "traefikId", "traefikState", "volume",
        "migrations", "secretsValid", "freeBytes", "rollbackReady", "unexpectedStaging", "lockHeld",
    }
    if set(observed) != required:
        raise StopBeforeMutation("INCOMPLETE_BASELINE")
    if observed["hostname"] != plan["host"]["hostname"] or observed["architecture"] != plan["host"]["architecture"]:
        raise StopBeforeMutation("HOST_BASELINE_MISMATCH")
    baseline = plan["baseline"]
    candidate_exact = (
        observed["activeFingerprint"] == plan["candidate"]["bundleFingerprint"]
        and observed["apiImage"] == plan["candidate"]["image"]
    )
    baseline_exact = observed["activeFingerprint"] == baseline["activeBundleFingerprint"] and observed["apiImage"] == baseline["liveImage"]
    before = plan["migrations"]["appliedBefore"]
    after = before + plan["migrations"]["pending"]
    if candidate_exact and observed["migrations"] == after:
        state = "ALREADY_ACTIVE"
    elif observed["migrations"] == after and baseline_exact:
        raise EscalationRequired("MIGRATIONS_APPLIED_WITH_OLD_APPLICATION")
    elif baseline_exact and observed["migrations"] == before:
        state = "READY"
    else:
        raise StopBeforeMutation("LIVE_BASELINE_MISMATCH")
    if not healthy_snapshot(observed):
        raise StopBeforeMutation("UNHEALTHY_BASELINE")
    if observed["volume"] != baseline["volume"]:
        raise StopBeforeMutation("VOLUME_MISMATCH")
    if observed["secretsValid"] is not True:
        raise StopBeforeMutation("SECRET_METADATA_MISMATCH")
    if observed["freeBytes"] < plan["minimumFreeBytes"]:
        raise StopBeforeMutation("DISK_GATE_FAILED")
    if observed["unexpectedStaging"]:
        raise StopBeforeMutation("UNEXPECTED_STAGING_STATE")
    if observed["lockHeld"] and not deployment_lock_owned:
        raise StopBeforeMutation("DEPLOYMENT_LOCK_HELD")
    if state == "READY" and observed["rollbackReady"] is not False:
        raise StopBeforeMutation("UNEXPECTED_ROLLBACK_STAGING")
    if state == "ALREADY_ACTIVE" and observed["rollbackReady"] is not True:
        raise StopBeforeMutation("ROLLBACK_RELEASE_MISSING")
    if state == "ALREADY_ACTIVE" and not allow_candidate:
        return state
    return state


def healthy_snapshot(observed: Mapping[str, Any]) -> bool:
    return (
        observed.get("apiState") == "running"
        and observed.get("apiHealth") == "healthy"
        and observed.get("apiRestarts") == 0
        and observed.get("postgresHealth") == "healthy"
        and observed.get("traefikState") == "running"
    )


def validate_authorization(
    plan: Mapping[str, Any],
    actual_plan_sha: str,
    *,
    flag: bool,
    environment: Mapping[str, str],
    authorization_id: str | None,
    approved_plan_sha: str | None,
) -> None:
    if not flag:
        raise StopBeforeMutation("AUTHORIZATION_FLAG_MISSING")
    if environment.get("GENESIS_PRODUCTION_MUTATION_AUTHORIZED") != "true":
        raise StopBeforeMutation("AUTHORIZATION_ENV_MISSING")
    if authorization_id != plan["authorizationId"]:
        raise StopBeforeMutation("AUTHORIZATION_ID_MISMATCH")
    if approved_plan_sha != actual_plan_sha or not isinstance(approved_plan_sha, str) or not SHA_RE.fullmatch(approved_plan_sha):
        raise StopBeforeMutation("PLAN_SHA_MISMATCH")


def ssh_base(plan: Mapping[str, Any]) -> list[str]:
    host = plan["host"]
    return [
        "ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={host['knownHostsFile']}", "-i", host["identityFile"], "--", host["sshAlias"],
    ]


def validate_ssh_host_key(plan: Mapping[str, Any], run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run) -> None:
    host = plan["host"]
    known_hosts = Path(host["knownHostsFile"])
    identity = Path(host["identityFile"])
    if not known_hosts.is_file() or known_hosts.is_symlink() or not identity.is_file() or identity.is_symlink():
        raise StopBeforeMutation("SSH_IDENTITY_MISSING")
    if os.name != "nt":
        identity_metadata = identity.stat()
        if identity_metadata.st_uid != os.getuid() or stat.S_IMODE(identity_metadata.st_mode) not in {0o400, 0o600}:
            raise StopBeforeMutation("SSH_IDENTITY_METADATA_MISMATCH")
    found = run(
        ["ssh-keygen", "-F", host["sshAlias"], "-f", str(known_hosts)],
        capture_output=True, text=True, shell=False, timeout=10,
    )
    if found.returncode != 0 or not found.stdout:
        raise StopBeforeMutation("SSH_HOST_KEY_MISSING")
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as temporary:
        temporary.write(found.stdout)
        temporary_path = temporary.name
    try:
        fingerprint = run(
            ["ssh-keygen", "-lf", temporary_path, "-E", "sha256"],
            capture_output=True, text=True, shell=False, timeout=10,
        )
    finally:
        Path(temporary_path).unlink(missing_ok=True)
    if fingerprint.returncode != 0 or host["hostKeyFingerprint"] not in fingerprint.stdout.split():
        raise StopBeforeMutation("SSH_HOST_KEY_MISMATCH")


def transfer_prepared(plan: Mapping[str, Any], prepared: Path) -> None:
    """Transfer only the five allowlisted transport files and re-hash remotely."""
    validate_ssh_host_key(plan)
    names = (
        "current.tar",
        "rollback.tar",
        "deployment-plan.json",
        "deploy-api-release.py",
        "transfer-manifest.json",
    )
    actual = {path.name for path in prepared.iterdir() if path.is_file()}
    if actual != set(names) or any((prepared / name).is_symlink() for name in names):
        raise StopBeforeMutation("TRANSFER_FILE_SET_MISMATCH")
    workspace = plan["paths"]["remoteWorkspace"]
    base = ssh_base(plan)
    SystemRuntime._run([*base, "install", "-d", "-m", "0700", "--", workspace])
    host = plan["host"]
    scp = [
        "scp", "-q", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={host['knownHostsFile']}", "-i", host["identityFile"], "--",
        *[str(prepared / name) for name in names], f"{host['sshAlias']}:{workspace}/",
    ]
    SystemRuntime._run(scp, timeout=300)
    remote_paths = [f"{workspace}/{name}" for name in names]
    SystemRuntime._run([*base, "chmod", "0600", "--", *remote_paths])
    SystemRuntime._run([*base, "chmod", "0700", "--", f"{workspace}/deploy-api-release.py"])
    output = SystemRuntime._run([*base, "sha256sum", "--", *remote_paths])
    remote_hashes = [line.split(" ", 1)[0] for line in output.splitlines()]
    local_hashes = [sha256_file(prepared / name) for name in names]
    if remote_hashes != local_hashes:
        raise StopBeforeMutation("POST_TRANSFER_HASH_MISMATCH")


class SystemRuntime:
    """Production runtime. Every command is argv-only and output is never logged."""

    def __init__(self) -> None:
        if os.name != "posix" or not hasattr(os, "geteuid") or os.geteuid() != 0:
            raise StopBeforeMutation("ROOT_LINUX_RUNTIME_REQUIRED")
        self.mutations: list[str] = []
        self._five_xx_streak = 0
        self._verified_manager: Path | None = None

    @staticmethod
    def _run(argv: Sequence[str], *, input_text: str | None = None, timeout: int = 120) -> str:
        try:
            completed = subprocess.run(
                list(argv), input=input_text, capture_output=True, text=True, shell=False,
                timeout=timeout, check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise StopBeforeMutation("COMMAND_EXECUTION_FAILED") from exc
        if completed.returncode != 0:
            raise StopBeforeMutation("COMMAND_FAILED")
        return completed.stdout.strip()

    @classmethod
    def _inspect(cls, name: str) -> Mapping[str, Any]:
        data = json.loads(cls._run(["docker", "inspect", name]))
        if not isinstance(data, list) or len(data) != 1:
            raise StopBeforeMutation("CONTAINER_INSPECT_FAILED")
        return data[0]

    def verify_pair(self, plan: Mapping[str, Any], current: Path, rollback: Path) -> None:
        manager = current / "docker/production/release-tree-manager.py"
        self._run([
            sys.executable, str(manager), "verify-pair",
            "--current-bundle", str(current), "--current-fingerprint", plan["candidate"]["bundleFingerprint"],
            "--current-image", plan["candidate"]["image"], "--rollback-bundle", str(rollback),
            "--rollback-fingerprint", plan["rollback"]["bundleFingerprint"], "--rollback-image", plan["rollback"]["image"],
        ])
        self._verified_manager = manager

    def verify_active(self, plan: Mapping[str, Any], fingerprint: str, image: str, role: str = "current") -> None:
        active = Path(plan["paths"]["activeRelease"])
        if self._verified_manager is None:
            raise StopBeforeMutation("RELEASE_MANAGER_NOT_VERIFIED")
        manager = self._verified_manager
        self._run([
            sys.executable, str(manager), "verify-bundle", "--bundle", str(active),
            "--fingerprint", fingerprint, "--expected-image", image,
            "--expected-role", role,
        ])

    def snapshot(self, plan: Mapping[str, Any], release_root: Path) -> Mapping[str, Any]:
        baseline = plan["baseline"]
        api = self._inspect(baseline["apiContainer"])
        postgres = self._inspect(baseline["postgresContainer"])
        traefik = self._inspect(baseline["traefikContainer"])
        labels = api.get("Config", {}).get("Labels", {}) or {}
        if labels.get("com.docker.compose.project") != "genesis" or labels.get("com.docker.compose.service") != "api":
            raise StopBeforeMutation("API_LABEL_MISMATCH")
        postgres_labels = postgres.get("Config", {}).get("Labels", {}) or {}
        traefik_labels = traefik.get("Config", {}).get("Labels", {}) or {}
        if (
            postgres_labels.get("com.docker.compose.project") != "genesis"
            or postgres_labels.get("com.docker.compose.service") != "postgres"
            or traefik_labels.get("com.docker.compose.project") != "genesis"
            or traefik_labels.get("com.docker.compose.service") != "traefik"
        ):
            raise StopBeforeMutation("DEPENDENCY_LABEL_MISMATCH")
        secret_valid = all(self._secret_valid(secret) for secret in plan["secrets"])
        manifest = release_root / "release-manifest.json"
        active_fingerprint = f"sha256:{sha256_file(manifest)}" if manifest.is_file() and not manifest.is_symlink() else "missing"
        migration_sql = "SELECT name FROM public.migrations ORDER BY id;"
        migrations = self._run([
            "docker", "exec", "--user", "postgres", baseline["postgresContainer"], "psql", "-At",
            "-U", plan["migrations"]["bootstrapUser"], "-d", plan["migrations"]["database"], "-c", migration_sql,
        ]).splitlines()
        allowed_siblings = set(plan["paths"]["allowedExistingSiblings"])
        expected_rollback = release_root.parent / f".genesis-release-rollback-{plan['runId']}"
        rollback_ready = expected_rollback.is_dir() and not expected_rollback.is_symlink()
        siblings = [
            path.name for path in release_root.parent.iterdir()
            if path.name.startswith(".genesis-release-")
            and path.name not in allowed_siblings
            and not (path == expected_rollback and rollback_ready)
        ]
        lock_held = self._lock_is_held(Path(plan["paths"]["deploymentLock"]))
        return {
            "hostname": self._run(["hostname"]),
            "architecture": "linux/amd64" if self._run(["uname", "-sm"]) == "Linux x86_64" else "unsupported",
            "activeFingerprint": active_fingerprint,
            "apiImage": api.get("Config", {}).get("Image"),
            "apiState": api.get("State", {}).get("Status"),
            "apiHealth": api.get("State", {}).get("Health", {}).get("Status"),
            "apiRestarts": api.get("RestartCount"),
            "postgresId": postgres.get("Id"),
            "postgresHealth": postgres.get("State", {}).get("Health", {}).get("Status"),
            "traefikId": traefik.get("Id"),
            "traefikState": traefik.get("State", {}).get("Status"),
            "volume": self._run(["docker", "volume", "inspect", "--format", "{{.Name}}", baseline["volume"]]),
            "migrations": migrations,
            "secretsValid": secret_valid,
            "freeBytes": shutil.disk_usage(release_root.parent).free,
            "rollbackReady": rollback_ready,
            "unexpectedStaging": siblings,
            "lockHeld": lock_held,
        }

    @staticmethod
    def _secret_valid(secret: Mapping[str, Any]) -> bool:
        try:
            metadata = os.lstat(secret["path"])
        except OSError:
            return False
        return (
            stat.S_ISREG(metadata.st_mode)
            and not stat.S_ISLNK(metadata.st_mode)
            and metadata.st_uid == secret["uid"]
            and metadata.st_gid == secret["gid"]
            and f"{stat.S_IMODE(metadata.st_mode):04o}" == secret["mode"]
        )

    @staticmethod
    def _lock_is_held(path: Path) -> bool:
        if fcntl is None:
            raise StopBeforeMutation("LINUX_RUNTIME_REQUIRED")
        if not path.exists():
            return False
        if path.is_symlink() or not path.is_file():
            raise StopBeforeMutation("UNSAFE_DEPLOYMENT_LOCK")
        with path.open("rb") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(handle, fcntl.LOCK_UN)
                return False
            except BlockingIOError:
                return True

    def registry_pull(self, plan: Mapping[str, Any]) -> None:
        registry_secret = next(secret for secret in plan["secrets"] if secret["purpose"] == "registry")
        credentials = load_json(Path(registry_secret["path"]))
        if not isinstance(credentials, dict) or set(credentials) != {"username", "password"}:
            raise StopBeforeMutation("INVALID_REGISTRY_CREDENTIAL_FILE")
        registry = plan["candidate"]["image"].split("/", 1)[0]
        with tempfile.TemporaryDirectory(prefix="genesis-docker-", dir="/run") as config:
            os.chmod(config, 0o700)
            self.mutations.append("registry-auth")
            self._run(["docker", "--config", config, "login", registry, "--username", credentials["username"], "--password-stdin"], input_text=credentials["password"] + "\n")
            self.mutations.append("pull")
            self._run(["docker", "--config", config, "pull", plan["candidate"]["image"]], timeout=600)
            self._run(["docker", "--config", config, "pull", plan["rollback"]["image"]], timeout=600)
            for image in (plan["candidate"]["image"], plan["rollback"]["image"]):
                inspected = json.loads(self._run(["docker", "image", "inspect", image]))
                if (
                    not isinstance(inspected, list)
                    or len(inspected) != 1
                    or inspected[0].get("Os") != "linux"
                    or inspected[0].get("Architecture") != "amd64"
                    or image not in inspected[0].get("RepoDigests", [])
                ):
                    raise StopBeforeMutation("PULLED_IMAGE_IDENTITY_MISMATCH")

    def migrate(self, plan: Mapping[str, Any], release_root: Path) -> None:
        self.mutations.append("migration")
        try:
            self._run(["docker", "compose", "--project-directory", str(release_root), "-f", str(release_root / "compose.production.yml"), "run", "--rm", "--no-deps", "migrate"], timeout=900)
        except StopBeforeMutation as exc:
            raise EscalationRequired("MIGRATION_FAILED_STATE_REQUIRES_RECONCILIATION") from exc

    def activate(self, plan: Mapping[str, Any], current: Path, rollback: Path) -> None:
        self.mutations.append("activation")
        manager = current / "docker/production/release-tree-manager.py"
        self._run([
            sys.executable, str(manager), "activate",
            "--current-bundle", str(current), "--current-fingerprint", plan["candidate"]["bundleFingerprint"],
            "--current-image", plan["candidate"]["image"], "--rollback-bundle", str(rollback),
            "--rollback-fingerprint", plan["rollback"]["bundleFingerprint"], "--rollback-image", plan["rollback"]["image"],
            "--run-id", plan["runId"],
        ], timeout=120)

    def recreate_api(self, plan: Mapping[str, Any], release_root: Path) -> None:
        self.mutations.append("api-recreate")
        self._run(["docker", "compose", "--project-directory", str(release_root), "-f", str(release_root / "compose.production.yml"), "up", "-d", "--no-deps", "--force-recreate", "api"], timeout=300)
        name = plan["baseline"]["apiContainer"]
        inspected = self._inspect(name)
        contract = inspected.get("Config", {}).get("Healthcheck", {})
        interval = max(1.0, float(contract.get("Interval", 0)) / 1_000_000_000)
        health_timeout = max(1.0, float(contract.get("Timeout", 0)) / 1_000_000_000)
        start_period = max(0.0, float(contract.get("StartPeriod", 0)) / 1_000_000_000)
        retries = contract.get("Retries")
        if not isinstance(retries, int) or retries < 1 or not contract.get("Test"):
            raise StopBeforeMutation("API_HEALTH_CONTRACT_MISSING")
        deadline = time.monotonic() + start_period + (interval + health_timeout) * retries
        while time.monotonic() <= deadline:
            inspected = self._inspect(name)
            state = inspected.get("State", {})
            if state.get("Status") != "running":
                raise StopBeforeMutation("API_NOT_RUNNING")
            health = state.get("Health", {}).get("Status")
            if health == "healthy":
                return
            if health == "unhealthy":
                raise StopBeforeMutation("API_UNHEALTHY")
            time.sleep(min(interval, 10.0))
        raise StopBeforeMutation("API_HEALTH_TIMEOUT")

    def smoke(self, plan: Mapping[str, Any], minimal: bool = False) -> None:
        SmokeClient(plan).run(minimal=minimal)

    def observe(self, plan: Mapping[str, Any]) -> None:
        names = [
            plan["baseline"]["apiContainer"],
            plan["baseline"]["postgresContainer"],
            plan["baseline"]["traefikContainer"],
        ]
        rows = self._run([
            "docker", "stats", "--no-stream", "--format", "{{json .}}", *names,
        ]).splitlines()
        if len(rows) != 3:
            raise StopBeforeMutation("OBSERVABILITY_METRICS_FAILED")
        try:
            metrics = [json.loads(row) for row in rows]
        except json.JSONDecodeError as exc:
            raise StopBeforeMutation("OBSERVABILITY_METRICS_FAILED") from exc
        if any(not entry.get("CPUPerc") or not entry.get("MemUsage") for entry in metrics):
            raise StopBeforeMutation("OBSERVABILITY_METRICS_FAILED")
        logs = self._run(["docker", "logs", "--since", "2m", names[2]], timeout=30)
        five_xx = bool(re.search(r"(?:status|DownstreamStatus)[\"=: ]+5[0-9]{2}\b", logs, re.IGNORECASE))
        self._five_xx_streak = self._five_xx_streak + 1 if five_xx else 0
        if self._five_xx_streak >= 2:
            raise StopBeforeMutation("PERSISTENT_5XX")

    def rollback(self, plan: Mapping[str, Any]) -> None:
        self.mutations.append("application-rollback")
        rollback_path = Path("/opt/genesis") / f".genesis-release-rollback-{plan['runId']}"
        if not rollback_path.is_dir() or rollback_path.is_symlink():
            raise EscalationRequired("ROLLBACK_SIBLING_MISSING")
        active = Path(plan["paths"]["activeRelease"])
        manager = active / "docker/production/release-tree-manager.py"
        self._run([
            sys.executable, str(manager), "rollback", "--active-fingerprint", plan["candidate"]["bundleFingerprint"],
            "--active-image", plan["candidate"]["image"], "--rollback-path", str(rollback_path),
            "--rollback-fingerprint", plan["rollback"]["bundleFingerprint"], "--rollback-image", plan["rollback"]["image"],
            "--run-id", plan["runId"],
        ], timeout=120)
        self.recreate_api(plan, active)


class SmokeClient:
    def __init__(self, plan: Mapping[str, Any]):
        self.plan = plan
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        self.base = plan["smoke"]["baseUrl"].rstrip("/")

    def _request(self, path: str, *, data: Mapping[str, Any] | None = None, csrf: str | None = None) -> Any:
        headers = {"Accept": "application/json"}
        body = None
        if data is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(data).encode()
        if csrf is not None:
            headers["X-CSRF-Token"] = csrf
        request = urllib.request.Request(self.base + path, data=body, headers=headers, method="POST" if data is not None else "GET")
        try:
            with self.opener.open(request, timeout=10) as response:
                if response.status < 200 or response.status >= 300:
                    raise StopBeforeMutation("SMOKE_HTTP_FAILURE")
                raw = response.read(1024 * 1024 + 1)
        except (OSError, urllib.error.URLError) as exc:
            raise StopBeforeMutation("SMOKE_TRANSPORT_FAILURE") from exc
        if len(raw) > 1024 * 1024:
            raise StopBeforeMutation("SMOKE_RESPONSE_TOO_LARGE")
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise StopBeforeMutation("SMOKE_RESPONSE_INVALID") from exc

    def run(self, minimal: bool = False) -> None:
        for path in ("/health", "/api/v1/health", "/api/v1/health/live", "/api/v1/health/ready"):
            self._request(path)
        if minimal:
            return
        credentials = load_json(Path(self.plan["smoke"]["credentialsFile"]))
        if not isinstance(credentials, dict) or set(credentials) != {"email", "password"}:
            raise StopBeforeMutation("INVALID_SMOKE_CREDENTIAL_FILE")
        csrf_payload = self._request("/api/v1/auth/csrf")
        csrf = csrf_payload.get("csrfToken") if isinstance(csrf_payload, dict) else None
        if not isinstance(csrf, str) or not csrf:
            raise StopBeforeMutation("CSRF_SMOKE_FAILED")
        self._request("/api/v1/auth/login", data=credentials, csrf=csrf)
        self._request(self.plan["smoke"]["tenantProbePath"])
        kanban = self._request(self.plan["smoke"]["kanbanPath"])
        validate_kanban(kanban)


def validate_kanban(payload: Any) -> None:
    if not isinstance(payload, dict) or payload.get("currency") != "BRL":
        raise StopBeforeMutation("KANBAN_PROTOCOL_REGRESSION")
    if not isinstance(payload.get("expectedValueTotalMinor"), str) or not payload["expectedValueTotalMinor"].isdigit():
        raise StopBeforeMutation("KANBAN_PROTOCOL_REGRESSION")
    if not isinstance(payload.get("withoutExpectedValue"), int):
        raise StopBeforeMutation("KANBAN_PROTOCOL_REGRESSION")
    columns = payload.get("columns")
    if not isinstance(columns, list):
        raise StopBeforeMutation("KANBAN_PROTOCOL_REGRESSION")
    for column in columns:
        if not isinstance(column, dict) or not isinstance(column.get("expectedValueTotalMinor"), str) or not isinstance(column.get("withoutExpectedValue"), int):
            raise StopBeforeMutation("KANBAN_PROTOCOL_REGRESSION")
        items = column.get("items")
        if not isinstance(items, list):
            raise StopBeforeMutation("KANBAN_PROTOCOL_REGRESSION")
        for card in items:
            value = card.get("expectedValueMinor") if isinstance(card, dict) else object()
            if value is not None and (not isinstance(value, str) or not value.isdigit()):
                raise StopBeforeMutation("KANBAN_PROTOCOL_REGRESSION")


def preflight(plan: Mapping[str, Any], current: Path, rollback: Path, runtime: Runtime, evidence: Evidence) -> str:
    validate_bundle_pair(current, rollback, plan)
    runtime.verify_pair(plan, current, rollback)
    observed = runtime.snapshot(plan, Path(plan["paths"]["activeRelease"]))
    state = validate_snapshot(plan, observed)
    runtime.verify_active(plan, observed["activeFingerprint"], observed["apiImage"])
    evidence.emit("preflight", "PRE_MUTATION_READY", state=state)
    return state


@contextlib.contextmanager
def deployment_lock(path: Path):
    if fcntl is None:
        raise StopBeforeMutation("LINUX_RUNTIME_REQUIRED")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise StopBeforeMutation("DEPLOYMENT_LOCK_HELD") from exc
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def run_observation(
    plan: Mapping[str, Any],
    runtime: Runtime,
    evidence: Evidence,
    *,
    deployment_lock_owned: bool,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    started = monotonic()
    for checkpoint in OBSERVATION_CHECKPOINTS:
        wait = started + checkpoint - monotonic()
        if wait > 0:
            sleep(wait)
        observed = runtime.snapshot(plan, Path(plan["paths"]["activeRelease"]))
        state = validate_snapshot(
            plan,
            observed,
            allow_candidate=True,
            deployment_lock_owned=deployment_lock_owned,
        )
        if state != "ALREADY_ACTIVE":
            raise StopBeforeMutation("CANDIDATE_NOT_ACTIVE_DURING_OBSERVATION")
        runtime.verify_active(plan, observed["activeFingerprint"], observed["apiImage"])
        runtime.smoke(plan, minimal=True)
        runtime.observe(plan)
        evidence.emit("observation", "PASS", checkpointSeconds=checkpoint)


def execute(
    plan: Mapping[str, Any],
    current: Path,
    rollback: Path,
    runtime: Runtime,
    evidence: Evidence,
    actual_plan_sha: str,
    *,
    flag: bool,
    environment: Mapping[str, str],
    authorization_id: str | None,
    approved_plan_sha: str | None,
    lock_factory: Callable[[Path], Any] = deployment_lock,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    state = preflight(plan, current, rollback, runtime, evidence)
    if state == "ALREADY_ACTIVE":
        evidence.emit("execute", "NO_OP", state=state)
        return state
    # Authorization is checked before taking the deployment lock and repeated
    # under the lock. Absence/mismatch therefore has zero production mutation.
    validate_authorization(
        plan, actual_plan_sha, flag=flag, environment=environment,
        authorization_id=authorization_id, approved_plan_sha=approved_plan_sha,
    )
    with lock_factory(Path(plan["paths"]["deploymentLock"])):
        # All snapshots in this block observe the lock owned by this execution.
        # External preflight keeps the default fail-closed lock interpretation.
        validate_bundle_pair(current, rollback, plan)
        runtime.verify_pair(plan, current, rollback)
        observed = runtime.snapshot(plan, Path(plan["paths"]["activeRelease"]))
        repeated = validate_snapshot(plan, observed, deployment_lock_owned=True)
        runtime.verify_active(plan, observed["activeFingerprint"], observed["apiImage"])
        if repeated == "ALREADY_ACTIVE":
            evidence.emit("execute", "NO_OP", state=repeated)
            return repeated
        validate_authorization(
            plan, actual_plan_sha, flag=flag, environment=environment,
            authorization_id=authorization_id, approved_plan_sha=approved_plan_sha,
        )
        evidence.emit("authorization", "MUTATION_AUTHORIZED")
        postgres_id = observed["postgresId"]
        traefik_id = observed["traefikId"]
        activated = False
        try:
            runtime.registry_pull(plan)
            runtime.migrate(plan, current)
            migration_state = runtime.snapshot(plan, Path(plan["paths"]["activeRelease"]))
            expected_migrations = plan["migrations"]["appliedBefore"] + plan["migrations"]["pending"]
            if migration_state["migrations"] != expected_migrations:
                raise EscalationRequired("MIGRATION_OUTCOME_AMBIGUOUS")
            runtime.activate(plan, current, rollback)
            activated = True
            runtime.recreate_api(plan, Path(plan["paths"]["activeRelease"]))
            candidate_state = runtime.snapshot(plan, Path(plan["paths"]["activeRelease"]))
            if candidate_state["postgresId"] != postgres_id or candidate_state["traefikId"] != traefik_id:
                raise StopBeforeMutation("DEPENDENCY_CONTAINER_RECREATED")
            if validate_snapshot(
                plan,
                candidate_state,
                allow_candidate=True,
                deployment_lock_owned=True,
            ) != "ALREADY_ACTIVE":
                raise StopBeforeMutation("CANDIDATE_HEALTH_FAILED")
            runtime.verify_active(plan, candidate_state["activeFingerprint"], candidate_state["apiImage"])
            runtime.smoke(plan)
            run_observation(
                plan,
                runtime,
                evidence,
                deployment_lock_owned=True,
                monotonic=monotonic,
                sleep=sleep,
            )
        except (StopBeforeMutation, EscalationRequired):
            if not activated:
                evidence.emit("execute", "STOPPED", reasonCode="PRE_ACTIVATION_FAILURE")
                raise
            try:
                runtime.rollback(plan)
                rolled_back = runtime.snapshot(plan, Path(plan["paths"]["activeRelease"]))
                if rolled_back["activeFingerprint"] != plan["rollback"]["bundleFingerprint"] or rolled_back["apiImage"] != plan["rollback"]["image"]:
                    raise EscalationRequired("ROLLBACK_VERIFICATION_FAILED")
                runtime.verify_active(plan, rolled_back["activeFingerprint"], rolled_back["apiImage"], "rollback")
                if rolled_back["migrations"] != plan["migrations"]["appliedBefore"] + plan["migrations"]["pending"]:
                    raise EscalationRequired("SCHEMA_NOT_PRESERVED")
                runtime.smoke(plan, minimal=True)
                evidence.emit("rollback", "APPLICATION_ROLLBACK_COMPLETE")
            except Exception as rollback_exc:
                evidence.emit("rollback", "ESCALATION_REQUIRED", reasonCode="ROLLBACK_FAILED")
                raise EscalationRequired("ROLLBACK_FAILED") from rollback_exc
            raise EscalationRequired("CANDIDATE_ROLLED_BACK_NO_AUTOMATIC_RETRY")
    evidence.emit("execute", "CANDIDATE_OBSERVED", state="READY_FOR_KEEP")
    return "CANDIDATE_OBSERVED / READY_FOR_KEEP"


def prepare_command(args: argparse.Namespace) -> int:
    plan = validate_plan(load_json(args.plan))
    actual_sha = plan_sha(args.plan)
    if args.approved_plan_sha != actual_sha:
        raise StopBeforeMutation("PLAN_SHA_MISMATCH")
    evidence = make_evidence(plan, actual_sha, args.evidence)
    if args.from_transport is not None:
        if args.transfer or args.current_bundle is not None or args.rollback_bundle is not None:
            raise StopBeforeMutation("CONFLICTING_PREPARE_MODE")
        if args.evidence != args.from_transport / "evidence.jsonl":
            raise StopBeforeMutation("UNAPPROVED_EVIDENCE_PATH")
        materialize_transport(args.from_transport, args.output_dir, plan, actual_sha)
        evidence.emit("materialize", "PASS")
        return 0
    if args.current_bundle is None or args.rollback_bundle is None:
        raise StopBeforeMutation("BUNDLES_REQUIRED")
    output = args.output_dir.resolve()
    current_root = args.current_bundle.resolve()
    rollback_root = args.rollback_bundle.resolve()
    evidence_path = args.evidence.resolve()
    if (
        output.is_relative_to(current_root)
        or output.is_relative_to(rollback_root)
        or evidence_path.is_relative_to(output)
    ):
        raise StopBeforeMutation("UNAPPROVED_PREPARE_OUTPUT_PATH")
    current_manifest, rollback_manifest = validate_bundle_pair(args.current_bundle, args.rollback_bundle, plan)
    operator_source = Path(__file__).resolve()
    operator_entry = next(
        entry for entry in current_manifest["artifacts"]
        if entry["path"] == "docker/production/deploy-api-release.py"
    )
    if sha256_file(operator_source) != operator_entry["sha256"]:
        raise StopBeforeMutation("RUNNING_OPERATOR_NOT_BUNDLE_BOUND")
    args.output_dir.mkdir(parents=True, exist_ok=False)
    os.chmod(args.output_dir, 0o700)
    current_archive = args.output_dir / "current.tar"
    rollback_archive = args.output_dir / "rollback.tar"
    current_hash = deterministic_archive(args.current_bundle, current_manifest, current_archive)
    rollback_hash = deterministic_archive(args.rollback_bundle, rollback_manifest, rollback_archive)
    operator_target = args.output_dir / "deploy-api-release.py"
    shutil.copyfile(operator_source, operator_target)
    os.chmod(operator_target, 0o700)
    shutil.copyfile(args.plan, args.output_dir / "deployment-plan.json")
    manifest = {
        "schemaVersion": "genesis-api-deployment-transfer.v1",
        "runId": plan["runId"],
        "approvedPlanSha256": actual_sha,
        "files": [
            {"path": "current.tar", "sha256": current_hash, "mode": "0600"},
            {"path": "rollback.tar", "sha256": rollback_hash, "mode": "0600"},
            {"path": "deployment-plan.json", "sha256": sha256_file(args.plan), "mode": "0600"},
            {"path": "deploy-api-release.py", "sha256": sha256_file(operator_source), "mode": "0700"},
        ],
    }
    for entry in manifest["files"]:
        os.chmod(args.output_dir / entry["path"], int(entry["mode"], 8))
    (args.output_dir / "transfer-manifest.json").write_bytes(canonical_json(manifest))
    os.chmod(args.output_dir / "transfer-manifest.json", 0o600)
    evidence.emit("prepare", "PASS", archiveSha256=current_hash, role="current")
    evidence.emit("prepare", "PASS", archiveSha256=rollback_hash, role="rollback")
    if args.transfer:
        transfer_prepared(plan, args.output_dir)
        evidence.emit("transfer", "PASS")
    return 0


def common_parser(parser: argparse.ArgumentParser, *, require_bundles: bool = True) -> None:
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--approved-plan-sha", required=True)
    parser.add_argument("--current-bundle", type=Path, required=require_bundles)
    parser.add_argument("--rollback-bundle", type=Path, required=require_bundles)
    parser.add_argument("--evidence", type=Path, required=True)


def validate_runtime_paths(args: argparse.Namespace, plan: Mapping[str, Any]) -> None:
    workspace = Path(plan["paths"]["remoteWorkspace"])
    expected_root = workspace / "materialized"
    if args.current_bundle != expected_root / "current" or args.rollback_bundle != expected_root / "rollback":
        raise StopBeforeMutation("UNAPPROVED_RUNTIME_BUNDLE_PATH")
    if args.evidence != workspace / "evidence.jsonl":
        raise StopBeforeMutation("UNAPPROVED_EVIDENCE_PATH")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deploy-api-release.py")
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    common_parser(prepare_parser, require_bundles=False)
    prepare_parser.add_argument("--output-dir", type=Path, required=True)
    prepare_parser.add_argument("--transfer", action="store_true")
    prepare_parser.add_argument("--from-transport", type=Path)
    preflight_parser = commands.add_parser("preflight")
    common_parser(preflight_parser)
    execute_parser = commands.add_parser("execute")
    common_parser(execute_parser)
    execute_parser.add_argument("--authorize-production-mutation", action="store_true")
    execute_parser.add_argument("--authorization-id")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "prepare":
            return prepare_command(args)
        plan = validate_plan(load_json(args.plan))
        validate_runtime_paths(args, plan)
        actual_sha = plan_sha(args.plan)
        if args.approved_plan_sha != actual_sha:
            raise StopBeforeMutation("PLAN_SHA_MISMATCH")
        evidence = make_evidence(plan, actual_sha, args.evidence)
        runtime = SystemRuntime()
        if args.command == "preflight":
            preflight(plan, args.current_bundle, args.rollback_bundle, runtime, evidence)
            return 0
        result = execute(
            plan, args.current_bundle, args.rollback_bundle, runtime, evidence, actual_sha,
            flag=args.authorize_production_mutation, environment=os.environ,
            authorization_id=args.authorization_id, approved_plan_sha=args.approved_plan_sha,
        )
        print(result)
        return 0
    except StopBeforeMutation as exc:
        print(f"STOP BEFORE MUTATION: {exc}", file=sys.stderr)
        return 2
    except EscalationRequired as exc:
        print(f"ESCALATION REQUIRED: {exc}", file=sys.stderr)
        return 3
    except Exception:
        # Never serialize exception values: library/subprocess errors may carry
        # command output. The detailed diagnosis remains local to a controlled
        # test environment, while production evidence stays non-sensitive.
        print("ESCALATION REQUIRED: INTERNAL_FAILURE", file=sys.stderr)
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
