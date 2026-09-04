#!/usr/bin/env python3
"""Fail-closed deployment operator for the Genesis single-API VPS.

This module deliberately has no persistent workflow state machine. Docker is
the runtime authority, TypeORM is the migration authority, and api-image.env is
only the desired immutable API image pointer.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import datetime as dt
import hashlib
import http.cookiejar
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Mapping, MutableMapping, Sequence

try:
    import fcntl
except ModuleNotFoundError:  # Windows imports this module only for unit tests.
    fcntl = None  # type: ignore[assignment]


SCHEMA_VERSION = "genesis-operational-integrity.v1"
EVIDENCE_VERSION = "genesis-simple-deploy-evidence.v1"
IMAGE_REPOSITORY = "ghcr.io/arthurportodev/genesis-platform-api"
IMAGE_PATTERN = re.compile(rf"^{re.escape(IMAGE_REPOSITORY)}@sha256:[a-f0-9]{{64}}$")
SHA_PATTERN = re.compile(r"^[a-f0-9]{40}$")
RUN_ID_PATTERN = re.compile(r"^[a-f0-9]{16}$")
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
DECIMAL_PATTERN = re.compile(r"^(0|[1-9][0-9]*)$")
CSRF_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")

DEPLOY_ROOT = Path("/opt/genesis/deploy")
PRODUCTION_ENV = Path("/opt/genesis/config/production.env")
IMAGE_POINTER = Path("/opt/genesis/config/api-image.env")
INTEGRITY_MANIFEST = DEPLOY_ROOT / "operational-integrity.json"
LOCK_PATH = Path("/run/lock/genesis-api-deploy.lock")
EVIDENCE_ROOT = Path("/var/lib/genesis/deploy/evidence")
REGISTRY_CREDENTIALS = Path("/opt/genesis/secrets/registry-credentials.json")
SMOKE_CREDENTIALS = Path("/opt/genesis/secrets/smoke-credentials.json")
RELEASE_EVIDENCE = Path("/opt/genesis/config/api-release-evidence.json")
RECOVERY_RUNNER = Path("/opt/genesis/recovery/backup-runner.sh")
RECOVERY_ENV = Path("/opt/genesis/recovery/recovery.env")
RECOVERY_STATUS = Path("/var/lib/genesis/recovery/status/backup-status.v1.json")

COMPOSE_FILES = (
    DEPLOY_ROOT / "compose.production.yml",
    DEPLOY_ROOT / "compose.production.functional.yml",
    DEPLOY_ROOT / "compose.traefik-public-full.yml",
)
OPERATIONAL_FILES = (
    "compose.production.yml",
    "compose.production.functional.yml",
    "compose.traefik-public-full.yml",
    "docker/postgres/init-runtime-role.sh",
    "docker/production/api-entrypoint.sh",
    "docker/production/deploy-api-simple.py",
    "docker/production/migrate-entrypoint.sh",
    "docker/traefik/dynamic/api-functional.template.yml",
    "docker/traefik/dynamic/api-health-only.yml",
    "docker/traefik/render-static-config.sh",
    "docker/traefik/traefik-acme-production.yml",
    "docker/traefik/traefik-acme-staging.yml",
    "docker/traefik/traefik-internal.yml",
)
PRODUCTION_ENV_KEYS = frozenset(
    {
        "DATABASE_NAME",
        "DATABASE_BOOTSTRAP_USER",
        "DATABASE_MIGRATION_USER",
        "DATABASE_RUNTIME_ROLE",
        "APP_NAME",
        "APP_VERSION",
        "ACME_EMAIL",
        "TRUST_PROXY_HOPS",
        "JWT_ACCESS_EXPIRES_IN",
        "REFRESH_TOKEN_EXPIRES_IN_DAYS",
        "LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION",
        "API_CPUS",
        "API_MEMORY_LIMIT",
        "API_PIDS_LIMIT",
        "API_NODE_MAX_OLD_SPACE_MB",
        "MIGRATE_CPUS",
        "MIGRATE_MEMORY_LIMIT",
        "MIGRATE_PIDS_LIMIT",
        "MIGRATE_NODE_MAX_OLD_SPACE_MB",
        "POSTGRES_CPUS",
        "POSTGRES_MEMORY_LIMIT",
        "POSTGRES_PIDS_LIMIT",
        "TRAEFIK_CPUS",
        "TRAEFIK_MEMORY_LIMIT",
        "TRAEFIK_PIDS_LIMIT",
    }
)
COMPOSE_CONTROL_KEYS = frozenset(
    {
        "API_IMAGE",
        "COMPOSE_FILE",
        "COMPOSE_PROJECT_NAME",
        "COMPOSE_PROFILES",
        "COMPOSE_ENV_FILES",
        "COMPOSE_PATH_SEPARATOR",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
    }
)
COMPOSE_SECRET_FILES = (
    Path("/opt/genesis/secrets/postgres-bootstrap-password"),
    Path("/opt/genesis/secrets/database-migration-password"),
    Path("/opt/genesis/secrets/database-runtime-password"),
    Path("/opt/genesis/secrets/jwt-access-secret"),
    Path("/opt/genesis/secrets/refresh-token-pepper"),
    Path("/opt/genesis/secrets/lead-idempotency-keys"),
    Path("/opt/genesis/secrets/origin-proxy-key"),
)
OBSERVATION_CHECKPOINTS = {1: (0, 30, 120), 2: (0, 60, 300)}
EXPECTED_STAGES = ("new", "qualification", "diagnosis", "proposal", "negotiation")
COMMAND_READ_TIMEOUT_SECONDS = 60
IMAGE_TRANSFER_TIMEOUT_SECONDS = 300
COMPOSE_MUTATION_TIMEOUT_SECONDS = 300
MIGRATION_TIMEOUT_SECONDS = 600
CHECKPOINT_TIMEOUT_SECONDS = 900
TRAEFIK_HTTP_STATUS_FIELDS = ("DownstreamStatus",)
LOG_SENSITIVE_PATTERN = re.compile(
    r"(?i)(authorization\s*[:=]|bearer\s+\S+|password\s*[:=]|access[_-]?token\s*[:=]|refresh[_-]?token\s*[:=]|csrf(?:[_-]?token)?\s*[:=]|cookie\s*[:=]|set-cookie\s*[:=])"
)
SENSITIVE_KEY_PATTERN = re.compile(
    r"(?i)^(authorization|password|access[_-]?token|refresh[_-]?token|csrf[_-]?token|cookie|set-cookie|body)$"
)


class DeployStop(RuntimeError):
    """A fail-closed terminal with a stable, non-sensitive reason code."""

    def __init__(self, reason_code: str):
        super().__init__(reason_code)
        self.reason_code = reason_code


@dataclasses.dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class CommandRunner:
    def run(
        self,
        argv: Sequence[str],
        *,
        env: Mapping[str, str] | None = None,
        input_text: str | None = None,
        check: bool = True,
        timeout_seconds: float = COMMAND_READ_TIMEOUT_SECONDS,
    ) -> CommandResult:
        require(timeout_seconds > 0, "INVALID_SUBPROCESS_TIMEOUT")
        try:
            completed = subprocess.run(
                list(argv),
                env=None if env is None else dict(env),
                input=input_text,
                text=True,
                capture_output=True,
                check=False,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as error:
            raise DeployStop("SUBPROCESS_TIMEOUT") from error
        result = CommandResult(completed.returncode, completed.stdout, completed.stderr)
        if check and result.returncode != 0:
            raise DeployStop("SUBPROCESS_FAILED")
        return result


@dataclasses.dataclass(frozen=True)
class MetadataPolicy:
    uid: int | None = 0
    gid: int | None = 0
    require_single_link: bool = True


@dataclasses.dataclass(frozen=True)
class DeploymentPaths:
    deploy_root: Path = DEPLOY_ROOT
    production_env: Path = PRODUCTION_ENV
    pointer: Path = IMAGE_POINTER
    manifest: Path = INTEGRITY_MANIFEST
    lock: Path = LOCK_PATH
    evidence_root: Path = EVIDENCE_ROOT
    registry_credentials: Path = REGISTRY_CREDENTIALS
    smoke_credentials: Path = SMOKE_CREDENTIALS
    release_evidence: Path = RELEASE_EVIDENCE
    recovery_runner: Path = RECOVERY_RUNNER
    recovery_env: Path = RECOVERY_ENV
    recovery_status: Path = RECOVERY_STATUS

    @property
    def compose_files(self) -> tuple[Path, ...]:
        return tuple(self.deploy_root / path.name for path in COMPOSE_FILES)


def require(condition: bool, reason_code: str) -> None:
    if not condition:
        raise DeployStop(reason_code)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_json(path: Path, reason_code: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise DeployStop(reason_code) from error


def validate_regular_metadata(
    path: Path,
    *,
    policy: MetadataPolicy,
    expected_mode: int | None = None,
    reason_code: str = "UNSAFE_FILE_METADATA",
) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise DeployStop(reason_code) from error
    require(stat.S_ISREG(metadata.st_mode), reason_code)
    require(not path.is_symlink(), reason_code)
    if policy.require_single_link:
        require(metadata.st_nlink == 1, reason_code)
    if policy.uid is not None:
        require(metadata.st_uid == policy.uid, reason_code)
    if policy.gid is not None:
        require(metadata.st_gid == policy.gid, reason_code)
    portable_fixture = os.name == "nt" and policy.uid is None and policy.gid is None
    if expected_mode is not None and not portable_fixture:
        require(stat.S_IMODE(metadata.st_mode) == expected_mode, reason_code)
    return metadata


def validate_safe_directory(
    path: Path, *, policy: MetadataPolicy, reason_code: str = "UNSAFE_PARENT_DIRECTORY"
) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise DeployStop(reason_code) from error
    require(stat.S_ISDIR(metadata.st_mode) and not path.is_symlink(), reason_code)
    if policy.uid is not None:
        require(metadata.st_uid == policy.uid, reason_code)
    if policy.gid is not None:
        require(metadata.st_gid == policy.gid, reason_code)
    portable_fixture = os.name == "nt" and policy.uid is None and policy.gid is None
    if not portable_fixture:
        require(stat.S_IMODE(metadata.st_mode) & 0o022 == 0, reason_code)


def normalized_relative_path(value: str) -> str:
    require(isinstance(value, str) and value != "", "INVALID_OPERATIONAL_MANIFEST")
    pure = PurePosixPath(value)
    require(not pure.is_absolute(), "OPERATIONAL_PATH_TRAVERSAL")
    require(".." not in pure.parts and "." not in pure.parts, "OPERATIONAL_PATH_TRAVERSAL")
    require("\\" not in value and value == pure.as_posix(), "OPERATIONAL_PATH_TRAVERSAL")
    return value


def parse_env_bytes(source: bytes) -> dict[str, str]:
    try:
        text = source.decode("utf-8")
    except UnicodeDecodeError as error:
        raise DeployStop("INVALID_PRODUCTION_ENV") from error
    require(text.endswith("\n") and "\r" not in text, "INVALID_PRODUCTION_ENV")
    parsed: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        require("=" in line, "INVALID_PRODUCTION_ENV")
        key, value = line.split("=", 1)
        require(re.fullmatch(r"[A-Z][A-Z0-9_]*", key) is not None, "INVALID_PRODUCTION_ENV")
        require(key not in parsed and value != "", "INVALID_PRODUCTION_ENV")
        parsed[key] = value
    return parsed


def validate_production_values(values: Mapping[str, str]) -> None:
    require(set(values) == PRODUCTION_ENV_KEYS, "PRODUCTION_ENV_KEYS_DIVERGED")
    for key in ("DATABASE_NAME", "DATABASE_BOOTSTRAP_USER", "DATABASE_MIGRATION_USER", "DATABASE_RUNTIME_ROLE"):
        require(re.fullmatch(r"[a-z_][a-z0-9_]*", values[key]) is not None, "INVALID_PRODUCTION_ENV_VALUE")
    require(len({values[key] for key in ("DATABASE_BOOTSTRAP_USER", "DATABASE_MIGRATION_USER", "DATABASE_RUNTIME_ROLE")}) == 3, "INVALID_PRODUCTION_ENV_VALUE")
    require(values["TRUST_PROXY_HOPS"] == "1", "INVALID_PRODUCTION_ENV_VALUE")
    require(values["LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION"] == "1", "INVALID_PRODUCTION_ENV_VALUE")
    require(re.fullmatch(r"[^@\s]+@[^@\s]+", values["ACME_EMAIL"]) is not None, "INVALID_PRODUCTION_ENV_VALUE")
    for key in ("API_PIDS_LIMIT", "API_NODE_MAX_OLD_SPACE_MB", "MIGRATE_PIDS_LIMIT", "MIGRATE_NODE_MAX_OLD_SPACE_MB", "POSTGRES_PIDS_LIMIT", "TRAEFIK_PIDS_LIMIT", "REFRESH_TOKEN_EXPIRES_IN_DAYS"):
        require(values[key].isdigit() and int(values[key]) > 0, "INVALID_PRODUCTION_ENV_VALUE")
    for key in ("API_CPUS", "MIGRATE_CPUS", "POSTGRES_CPUS", "TRAEFIK_CPUS"):
        try:
            valid = float(values[key]) > 0
        except ValueError:
            valid = False
        require(valid, "INVALID_PRODUCTION_ENV_VALUE")
    for key in ("API_MEMORY_LIMIT", "MIGRATE_MEMORY_LIMIT", "POSTGRES_MEMORY_LIMIT", "TRAEFIK_MEMORY_LIMIT"):
        require(re.fullmatch(r"[1-9][0-9]*[kKmMgG]", values[key]) is not None, "INVALID_PRODUCTION_ENV_VALUE")
    require(re.fullmatch(r"[1-9][0-9]*[smhd]", values["JWT_ACCESS_EXPIRES_IN"]) is not None, "INVALID_PRODUCTION_ENV_VALUE")


def verify_git_operational_snapshot(
    root: Path,
    operational_source_sha: str,
    runner: CommandRunner,
    *,
    files: Sequence[str] = OPERATIONAL_FILES,
) -> None:
    require(
        SHA_PATTERN.fullmatch(operational_source_sha) is not None,
        "INVALID_OPERATIONAL_SOURCE_SHA",
    )
    normalized_files = tuple(normalized_relative_path(relative) for relative in files)
    head = runner.run(
        ("git", "-C", str(root), "rev-parse", "--verify", "HEAD"),
        timeout_seconds=COMMAND_READ_TIMEOUT_SECONDS,
    ).stdout.strip()
    approved_commit = runner.run(
        (
            "git",
            "-C",
            str(root),
            "rev-parse",
            "--verify",
            f"{operational_source_sha}^{{commit}}",
        ),
        timeout_seconds=COMMAND_READ_TIMEOUT_SECONDS,
    ).stdout.strip()
    require(
        head == operational_source_sha and approved_commit == operational_source_sha,
        "OPERATIONAL_SOURCE_NOT_APPROVED",
    )
    status = runner.run(
        (
            "git",
            "-C",
            str(root),
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--",
            *normalized_files,
        ),
        timeout_seconds=COMMAND_READ_TIMEOUT_SECONDS,
    )
    require(status.stdout == "", "OPERATIONAL_SOURCE_DIRTY")
    for relative in normalized_files:
        approved_blob = runner.run(
            (
                "git",
                "-C",
                str(root),
                "rev-parse",
                "--verify",
                f"{operational_source_sha}:{relative}",
            ),
            timeout_seconds=COMMAND_READ_TIMEOUT_SECONDS,
        ).stdout.strip()
        worktree_blob = runner.run(
            ("git", "-C", str(root), "hash-object", "--", relative),
            timeout_seconds=COMMAND_READ_TIMEOUT_SECONDS,
        ).stdout.strip()
        require(
            re.fullmatch(r"[a-f0-9]{40}", approved_blob) is not None
            and worktree_blob == approved_blob,
            "OPERATIONAL_SOURCE_BYTES_DIVERGED",
        )


def _operational_manifest_payload(
    root: Path,
    production_env: Path,
    operational_source_sha: str,
    *,
    files: Sequence[str] = OPERATIONAL_FILES,
) -> dict[str, Any]:
    require(
        SHA_PATTERN.fullmatch(operational_source_sha) is not None,
        "INVALID_OPERATIONAL_SOURCE_SHA",
    )
    entries: list[dict[str, str]] = []
    for relative in files:
        normalized_relative_path(relative)
        path = root / relative
        metadata = validate_regular_metadata(
            path, policy=MetadataPolicy(uid=None, gid=None), reason_code="INVALID_OPERATIONAL_SOURCE"
        )
        if os.name != "nt":
            require(
                stat.S_IMODE(metadata.st_mode) & 0o022 == 0,
                "INVALID_OPERATIONAL_SOURCE",
            )
        entries.append(
            {
                "path": relative,
                "sha256": sha256_file(path),
                "mode": (
                    "0644"
                    if os.name == "nt"
                    else f"{stat.S_IMODE(metadata.st_mode):04o}"
                ),
            }
        )
    config_metadata = validate_regular_metadata(
        production_env,
        policy=MetadataPolicy(uid=None, gid=None),
        expected_mode=0o600,
        reason_code="INVALID_PRODUCTION_ENV",
    )
    config_values = parse_env_bytes(production_env.read_bytes())
    validate_production_values(config_values)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "operationalSourceSha": operational_source_sha,
        "files": entries,
        "productionConfig": {
            "path": str(production_env),
            "sha256": sha256_file(production_env),
            "mode": "0600",
        },
    }


def build_operational_manifest(
    root: Path,
    production_env: Path,
    operational_source_sha: str,
    runner: CommandRunner,
    *,
    files: Sequence[str] = OPERATIONAL_FILES,
) -> dict[str, Any]:
    verify_git_operational_snapshot(
        root,
        operational_source_sha,
        runner,
        files=files,
    )
    return _operational_manifest_payload(
        root,
        production_env,
        operational_source_sha,
        files=files,
    )


def expected_directories(files: Iterable[str]) -> set[str]:
    result = {""}
    for relative in files:
        parent = PurePosixPath(relative).parent
        while parent.as_posix() != ".":
            result.add(parent.as_posix())
            parent = parent.parent
    return result


def verify_operational_integrity(
    paths: DeploymentPaths,
    expected_source_sha: str,
    *,
    policy: MetadataPolicy = MetadataPolicy(),
    files: Sequence[str] = OPERATIONAL_FILES,
) -> dict[str, str]:
    require(SHA_PATTERN.fullmatch(expected_source_sha) is not None, "INVALID_OPERATIONAL_SOURCE_SHA")
    validate_safe_directory(paths.deploy_root, policy=policy)
    validate_safe_directory(paths.deploy_root.parent, policy=policy)
    validate_regular_metadata(paths.manifest, policy=policy, expected_mode=0o600, reason_code="INVALID_OPERATIONAL_MANIFEST")
    manifest = safe_json(paths.manifest, "INVALID_OPERATIONAL_MANIFEST")
    require(isinstance(manifest, dict) and set(manifest) == {"schemaVersion", "operationalSourceSha", "files", "productionConfig"}, "INVALID_OPERATIONAL_MANIFEST")
    require(manifest["schemaVersion"] == SCHEMA_VERSION, "INVALID_OPERATIONAL_MANIFEST")
    require(manifest["operationalSourceSha"] == expected_source_sha, "OPERATIONAL_SOURCE_SHA_DIVERGED")
    raw_entries = manifest["files"]
    require(isinstance(raw_entries, list), "INVALID_OPERATIONAL_MANIFEST")
    entries: dict[str, dict[str, str]] = {}
    for raw in raw_entries:
        require(isinstance(raw, dict) and set(raw) == {"path", "sha256", "mode"}, "INVALID_OPERATIONAL_MANIFEST")
        relative = normalized_relative_path(raw["path"])
        require(relative not in entries, "INVALID_OPERATIONAL_MANIFEST")
        require(re.fullmatch(r"[a-f0-9]{64}", raw["sha256"]) is not None, "INVALID_OPERATIONAL_MANIFEST")
        require(re.fullmatch(r"0[0-7]{3}", raw["mode"]) is not None, "INVALID_OPERATIONAL_MANIFEST")
        require(int(raw["mode"], 8) & 0o022 == 0, "INVALID_OPERATIONAL_MANIFEST")
        entries[relative] = raw
    require(set(entries) == set(files), "OPERATIONAL_ALLOWLIST_DIVERGED")
    actual_files: set[str] = set()
    actual_directories: set[str] = {""}
    for current, directories, filenames in os.walk(paths.deploy_root, followlinks=False):
        current_path = Path(current)
        relative_dir = current_path.relative_to(paths.deploy_root).as_posix()
        if relative_dir == ".":
            relative_dir = ""
        validate_safe_directory(current_path, policy=policy)
        actual_directories.add(relative_dir)
        for directory in directories:
            child = current_path / directory
            require(not child.is_symlink(), "OPERATIONAL_SYMLINK")
        for filename in filenames:
            relative = (PurePosixPath(relative_dir) / filename).as_posix()
            actual_files.add(relative)
    require(actual_directories == expected_directories(files), "OPERATIONAL_DIRECTORY_SET_DIVERGED")
    require(actual_files == set(files) | {"operational-integrity.json"}, "OPERATIONAL_FILE_SET_DIVERGED")
    for relative, entry in entries.items():
        path = paths.deploy_root / relative
        mode = int(entry["mode"], 8)
        validate_regular_metadata(path, policy=policy, expected_mode=mode, reason_code="OPERATIONAL_FILE_METADATA_DIVERGED")
        require(sha256_file(path) == entry["sha256"], "OPERATIONAL_FILE_HASH_DIVERGED")
    config = manifest["productionConfig"]
    require(isinstance(config, dict) and set(config) == {"path", "sha256", "mode"}, "INVALID_OPERATIONAL_MANIFEST")
    require(config["path"] == str(paths.production_env), "PRODUCTION_ENV_PATH_DIVERGED")
    require(config["mode"] == "0600", "PRODUCTION_ENV_MODE_DIVERGED")
    validate_safe_directory(paths.production_env.parent, policy=policy)
    validate_regular_metadata(paths.production_env, policy=policy, expected_mode=0o600, reason_code="PRODUCTION_ENV_METADATA_DIVERGED")
    require(sha256_file(paths.production_env) == config["sha256"], "PRODUCTION_ENV_HASH_DIVERGED")
    values = parse_env_bytes(paths.production_env.read_bytes())
    validate_production_values(values)
    return values


def pointer_bytes(image: str) -> bytes:
    require(IMAGE_PATTERN.fullmatch(image) is not None, "INVALID_API_IMAGE")
    return f"API_IMAGE={image}\n".encode("ascii")


def read_pointer(
    path: Path, *, policy: MetadataPolicy = MetadataPolicy()
) -> str:
    validate_regular_metadata(path, policy=policy, expected_mode=0o600, reason_code="INVALID_API_IMAGE_POINTER")
    try:
        source = path.read_bytes()
    except OSError as error:
        raise DeployStop("INVALID_API_IMAGE_POINTER") from error
    match = re.fullmatch(rb"API_IMAGE=(ghcr\.io/arthurportodev/genesis-platform-api@sha256:[a-f0-9]{64})\n", source)
    require(match is not None, "INVALID_API_IMAGE_POINTER")
    return match.group(1).decode("ascii")


def validate_pointer_runtime(pointer_image: str, runtime_image: str) -> None:
    require(pointer_image == runtime_image, "POINTER_RUNTIME_DIVERGENCE")


def _set_file_owner(fd: int, uid: int | None, gid: int | None) -> None:
    if uid is None or gid is None:
        return
    require(hasattr(os, "fchown"), "FILE_OWNERSHIP_UNAVAILABLE")
    os.fchown(fd, uid, gid)


FaultHook = Callable[[str, Path], None]


def atomic_replace_bytes(
    target: Path,
    content: bytes,
    *,
    mode: int = 0o600,
    uid: int | None = 0,
    gid: int | None = 0,
    hook: FaultHook | None = None,
) -> None:
    callback = hook or (lambda _stage, _path: None)
    validate_safe_directory(target.parent, policy=MetadataPolicy(uid=uid, gid=gid))
    callback("before_write", target)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    temporary = Path(temporary_name)
    replaced = False
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            output.write(content)
            output.flush()
            if hasattr(os, "fchmod"):
                os.fchmod(output.fileno(), mode)
            else:
                os.chmod(temporary, mode)
            _set_file_owner(output.fileno(), uid, gid)
            callback("after_write", target)
            callback("before_fsync_file", target)
            os.fsync(output.fileno())
            callback("after_fsync_file", target)
        callback("before_replace", target)
        os.replace(temporary, target)
        replaced = True
        callback("after_replace", target)
        if os.name == "nt" and uid is None and gid is None:
            callback("before_fsync_directory", target)
            callback("after_fsync_directory", target)
        else:
            directory_fd = os.open(target.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                callback("before_fsync_directory", target)
                os.fsync(directory_fd)
                callback("after_fsync_directory", target)
            finally:
                os.close(directory_fd)
    finally:
        if not replaced:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()


def write_pointer(
    path: Path,
    image: str,
    *,
    uid: int | None = 0,
    gid: int | None = 0,
    hook: FaultHook | None = None,
) -> None:
    if path.exists() or path.is_symlink():
        validate_regular_metadata(path, policy=MetadataPolicy(uid=uid, gid=gid), expected_mode=0o600, reason_code="INVALID_API_IMAGE_POINTER")
    atomic_replace_bytes(path, pointer_bytes(image), uid=uid, gid=gid, hook=hook)


def sanitized_child_environment(
    parent: Mapping[str, str],
    production_keys: Iterable[str],
    *,
    api_image: str | None = None,
) -> dict[str, str]:
    denied = set(production_keys) | set(COMPOSE_CONTROL_KEYS)
    child = {key: value for key, value in parent.items() if key not in denied}
    if api_image is not None:
        require(IMAGE_PATTERN.fullmatch(api_image) is not None, "INVALID_API_IMAGE")
        child["API_IMAGE"] = api_image
    return child


class ComposeClient:
    def __init__(
        self,
        runner: CommandRunner,
        paths: DeploymentPaths,
        production_keys: Iterable[str],
        parent_environment: Mapping[str, str] | None = None,
    ):
        self.runner = runner
        self.paths = paths
        self.production_keys = tuple(production_keys)
        self.parent_environment = dict(os.environ if parent_environment is None else parent_environment)

    def base_argv(self) -> list[str]:
        argv = [
            "docker",
            "compose",
            "-p",
            "genesis",
            "--project-directory",
            str(self.paths.deploy_root),
            "--env-file",
            str(self.paths.production_env),
            "--env-file",
            str(self.paths.pointer),
        ]
        for compose_file in self.paths.compose_files:
            require(compose_file.is_absolute(), "COMPOSE_PATH_NOT_ABSOLUTE")
            argv.extend(("-f", str(compose_file)))
        return argv

    def run(
        self,
        arguments: Sequence[str],
        *,
        candidate_image: str | None = None,
        check: bool = True,
        timeout_seconds: float = COMMAND_READ_TIMEOUT_SECONDS,
    ) -> CommandResult:
        environment = sanitized_child_environment(
            self.parent_environment,
            self.production_keys,
            api_image=candidate_image,
        )
        return self.runner.run(
            [*self.base_argv(), *arguments],
            env=environment,
            check=check,
            timeout_seconds=timeout_seconds,
        )

    def render(self, expected_image: str) -> dict[str, Any]:
        result = self.run(("config", "--format", "json"))
        try:
            rendered = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise DeployStop("COMPOSE_RENDER_INVALID") from error
        validate_rendered_compose(rendered, expected_image)
        return rendered

    def service_id(self, service: str) -> str:
        result = self.run(("ps", "-q", service))
        value = result.stdout.strip()
        require(re.fullmatch(r"[a-f0-9]{12,64}", value) is not None, "CONTAINER_ID_UNAVAILABLE")
        return value

    def migration_inventory(self, candidate_image: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
        result = self.run(
            (
                "run",
                "--rm",
                "--no-deps",
                "migrate",
                "node",
                "node_modules/typeorm/cli.js",
                "-d",
                "dist/database/data-source.js",
                "migration:show",
            ),
            candidate_image=candidate_image,
            timeout_seconds=MIGRATION_TIMEOUT_SECONDS,
        )
        return parse_migration_inventory(result.stdout)

    def migrate(self, candidate_image: str) -> None:
        self.run(
            ("run", "--rm", "--no-deps", "migrate"),
            candidate_image=candidate_image,
            timeout_seconds=MIGRATION_TIMEOUT_SECONDS,
        )

    def recreate_api(self) -> None:
        self.run(
            ("up", "-d", "--no-deps", "--force-recreate", "api"),
            timeout_seconds=COMPOSE_MUTATION_TIMEOUT_SECONDS,
        )


def validate_rendered_compose(config: Mapping[str, Any], expected_image: str) -> None:
    require(IMAGE_PATTERN.fullmatch(expected_image) is not None, "INVALID_API_IMAGE")
    require(config.get("name") == "genesis", "COMPOSE_PROJECT_DIVERGED")
    services = config.get("services")
    require(isinstance(services, dict) and set(services) == {"api", "migrate", "postgres", "traefik"}, "COMPOSE_SERVICES_DIVERGED")
    require(services["api"].get("image") == expected_image, "COMPOSE_API_IMAGE_DIVERGED")
    require(services["migrate"].get("image") == expected_image, "COMPOSE_MIGRATE_IMAGE_DIVERGED")
    require("ports" not in services["api"] and "ports" not in services["postgres"], "COMPOSE_PUBLIC_PORT_DIVERGED")
    volume = config.get("volumes", {}).get("postgres_data", {})
    require(volume.get("external") is True and volume.get("name") == "genesis-postgres-data", "COMPOSE_VOLUME_DIVERGED")
    require(set(services["api"].get("networks", {})) == {"database", "edge"}, "COMPOSE_NETWORK_DIVERGED")
    require(set(services["postgres"].get("networks", {})) == {"database"}, "COMPOSE_NETWORK_DIVERGED")
    require(set(services["migrate"].get("networks", {})) == {"database"}, "COMPOSE_NETWORK_DIVERGED")
    require(set(services["traefik"].get("networks", {})) == {"edge"}, "COMPOSE_NETWORK_DIVERGED")


def parse_migration_inventory(source: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    executed: list[str] = []
    pending: list[str] = []
    ansi = re.compile(r"\x1b\[[0-9;]*m")
    for raw_line in source.splitlines():
        line = ansi.sub("", raw_line).strip()
        if not line:
            continue
        executed_match = re.fullmatch(
            r"\[X\]\s+[1-9][0-9]*\s+([A-Za-z0-9_.-]+)", line
        )
        pending_match = re.fullmatch(r"\[ \]\s+([A-Za-z0-9_.-]+)", line)
        require(
            (executed_match is None) != (pending_match is None),
            "AMBIGUOUS_MIGRATION_INVENTORY",
        )
        match = executed_match or pending_match
        require(match is not None, "AMBIGUOUS_MIGRATION_INVENTORY")
        name = match.group(1)
        require(name not in executed and name not in pending, "AMBIGUOUS_MIGRATION_INVENTORY")
        target = executed if executed_match is not None else pending
        target.append(name)
    require(executed or pending, "AMBIGUOUS_MIGRATION_INVENTORY")
    return tuple(executed), tuple(pending)


def validate_migration_inventory_after(
    before_executed: Sequence[str],
    approved_pending: Sequence[str],
    after_executed: Sequence[str],
    after_pending: Sequence[str],
) -> None:
    expected_after = tuple(before_executed) + tuple(approved_pending)
    require(
        not after_pending
        and len(set(after_executed)) == len(after_executed)
        and tuple(after_executed) == expected_after,
        "MIGRATION_INVENTORY_MISMATCH",
    )


@dataclasses.dataclass(frozen=True)
class ContainerState:
    container_id: str
    image: str
    status: str
    health: str | None
    restart_count: int
    volumes: tuple[str, ...] = ()


def inspect_container(runner: CommandRunner, container_id: str) -> ContainerState:
    result = runner.run(
        ("docker", "inspect", container_id),
        env=docker_child_environment(),
        timeout_seconds=COMMAND_READ_TIMEOUT_SECONDS,
    )
    try:
        raw = json.loads(result.stdout)
        item = raw[0]
        state = item["State"]
        image = item["Config"]["Image"]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError) as error:
        raise DeployStop("CONTAINER_INSPECT_INVALID") from error
    return ContainerState(
        container_id=str(item["Id"]),
        image=str(image),
        status=str(state["Status"]),
        health=None if "Health" not in state else str(state["Health"]["Status"]),
        restart_count=int(item.get("RestartCount", 0)),
        volumes=tuple(
            str(mount["Name"])
            for mount in item.get("Mounts", [])
            if isinstance(mount, dict)
            and mount.get("Type") == "volume"
            and isinstance(mount.get("Name"), str)
        ),
    )


def docker_child_environment() -> dict[str, str]:
    return sanitized_child_environment(os.environ, PRODUCTION_ENV_KEYS)


def prove_release_evidence(
    path: Path,
    application_source_sha: str,
    operational_source_sha: str,
    candidate_image: str,
    policy: MetadataPolicy,
) -> tuple[str, ...]:
    validate_regular_metadata(path, policy=policy, expected_mode=0o600, reason_code="RELEASE_EVIDENCE_INVALID")
    evidence = safe_json(path, "RELEASE_EVIDENCE_INVALID")
    require(
        isinstance(evidence, dict)
        and set(evidence)
        == {
            "applicationSourceSha",
            "operationalSourceSha",
            "candidateImage",
            "status",
            "approvedLevel2Pending",
        }
        and evidence["applicationSourceSha"] == application_source_sha
        and evidence["operationalSourceSha"] == operational_source_sha
        and evidence["candidateImage"] == candidate_image
        and evidence["status"] == "approved",
        "RELEASE_EVIDENCE_INVALID",
    )
    approved_pending = evidence["approvedLevel2Pending"]
    require(
        isinstance(approved_pending, list)
        and all(
            isinstance(name, str)
            and re.fullmatch(r"[A-Za-z0-9_.-]+", name) is not None
            for name in approved_pending
        )
        and len(set(approved_pending)) == len(approved_pending),
        "RELEASE_EVIDENCE_INVALID",
    )
    return tuple(approved_pending)


def inspect_image(runner: CommandRunner, image: str) -> Mapping[str, Any] | None:
    result = runner.run(
        ("docker", "image", "inspect", image),
        env=docker_child_environment(),
        check=False,
        timeout_seconds=COMMAND_READ_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        return None
    try:
        raw = json.loads(result.stdout)
        require(isinstance(raw, list) and len(raw) == 1, "IMAGE_INSPECT_INVALID")
        return raw[0]
    except json.JSONDecodeError as error:
        raise DeployStop("IMAGE_INSPECT_INVALID") from error


def pull_image(
    runner: CommandRunner,
    image: str,
    credentials_path: Path,
    *,
    policy: MetadataPolicy,
) -> None:
    validate_regular_metadata(credentials_path, policy=policy, expected_mode=0o600, reason_code="REGISTRY_CREDENTIALS_INVALID")
    credentials = safe_json(credentials_path, "REGISTRY_CREDENTIALS_INVALID")
    require(isinstance(credentials, dict) and set(credentials) == {"username", "password"}, "REGISTRY_CREDENTIALS_INVALID")
    require(all(isinstance(credentials[key], str) and credentials[key] for key in credentials), "REGISTRY_CREDENTIALS_INVALID")
    temporary = Path(tempfile.mkdtemp(prefix="genesis-docker-config-"))
    os.chmod(temporary, 0o700)
    environment = sanitized_child_environment(os.environ, PRODUCTION_ENV_KEYS)
    environment["DOCKER_CONFIG"] = str(temporary)
    try:
        login = runner.run(
            ("docker", "login", "ghcr.io", "--username", credentials["username"], "--password-stdin"),
            env=environment,
            input_text=f"{credentials['password']}\n",
            check=False,
            timeout_seconds=IMAGE_TRANSFER_TIMEOUT_SECONDS,
        )
        require(login.returncode == 0, "REGISTRY_LOGIN_FAILED")
        pulled = runner.run(
            ("docker", "pull", image),
            env=environment,
            check=False,
            timeout_seconds=IMAGE_TRANSFER_TIMEOUT_SECONDS,
        )
        require(pulled.returncode == 0, "IMAGE_PULL_FAILED")
    finally:
        shutil.rmtree(temporary)


def prove_image(
    runner: CommandRunner,
    image: str,
    *,
    credentials_path: Path,
    policy: MetadataPolicy,
    application_source_sha: str | None = None,
    allow_pull: bool = True,
) -> Mapping[str, Any]:
    require(IMAGE_PATTERN.fullmatch(image) is not None, "INVALID_API_IMAGE")
    inspected = inspect_image(runner, image)
    unavailable = (
        "CANDIDATE_IMAGE_UNAVAILABLE"
        if application_source_sha is not None
        else "PREVIOUS_IMAGE_UNAVAILABLE"
    )
    if inspected is None and allow_pull:
        try:
            pull_image(runner, image, credentials_path, policy=policy)
        except DeployStop as error:
            raise DeployStop(unavailable) from error
        inspected = inspect_image(runner, image)
    require(inspected is not None, unavailable)
    require(image in inspected.get("RepoDigests", []), "IMAGE_REPODIGEST_DIVERGED")
    require(inspected.get("Os") == "linux" and inspected.get("Architecture") == "amd64", "IMAGE_PLATFORM_DIVERGED")
    if application_source_sha is not None:
        revision = inspected.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.revision")
        require(
            revision == application_source_sha,
            "CANDIDATE_OCI_REVISION_DIVERGED",
        )
    return inspected


class DeploymentLock:
    def __init__(self, path: Path, policy: MetadataPolicy = MetadataPolicy()):
        self.path = path
        self.policy = policy
        self.file: Any = None

    def __enter__(self) -> "DeploymentLock":
        require(fcntl is not None, "FLOCK_UNAVAILABLE")
        validate_safe_directory(self.path.parent, policy=self.policy)
        if self.path.exists() or self.path.is_symlink():
            validate_regular_metadata(
                self.path,
                policy=self.policy,
                expected_mode=0o600,
                reason_code="DEPLOYMENT_LOCK_INVALID",
            )
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(self.path, flags, 0o600)
        os.fchmod(descriptor, 0o600)
        _set_file_owner(descriptor, self.policy.uid, self.policy.gid)
        self.file = os.fdopen(descriptor, "a+", encoding="utf-8")
        try:
            fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            self.file.close()
            raise DeployStop("DEPLOYMENT_LOCK_HELD") from error
        return self

    def __exit__(self, *_args: Any) -> None:
        if self.file is not None:
            fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
            self.file.close()


def probe_deployment_lock(
    path: Path,
    policy: MetadataPolicy = MetadataPolicy(),
) -> None:
    """Check an existing lock without creating or modifying filesystem state."""

    require(fcntl is not None, "FLOCK_UNAVAILABLE")
    validate_safe_directory(path.parent, policy=policy)
    if not path.exists() and not path.is_symlink():
        return
    validate_regular_metadata(
        path,
        policy=policy,
        expected_mode=0o600,
        reason_code="DEPLOYMENT_LOCK_INVALID",
    )
    try:
        descriptor = os.open(path, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise DeployStop("DEPLOYMENT_LOCK_HELD") from error
        finally:
            with contextlib.suppress(OSError):
                fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


class EvidenceStore:
    def __init__(
        self,
        path: Path,
        initial: Mapping[str, Any],
        *,
        uid: int | None = 0,
        gid: int | None = 0,
        hook: FaultHook | None = None,
    ):
        self.path = path
        self.uid = uid
        self.gid = gid
        self.hook = hook
        self.data = dict(initial)
        require(not path.exists() and not path.is_symlink(), "EVIDENCE_RUN_ALREADY_EXISTS")
        self.created = False
        self._write()
        self.created = True

    def _write(self) -> None:
        if self.created:
            validate_regular_metadata(
                self.path,
                policy=MetadataPolicy(uid=self.uid, gid=self.gid),
                expected_mode=0o600,
                reason_code="EVIDENCE_METADATA_DIVERGED",
            )
        payload = (json.dumps(self.data, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        validate_redacted_evidence(self.data)
        atomic_replace_bytes(self.path, payload, uid=self.uid, gid=self.gid, hook=self.hook)

    def update(self, **values: Any) -> None:
        self.data.update(values)
        self._write()

    def remember_failure(self, reason_code: str) -> None:
        if self.data.get("failureReasonCode") is None:
            self.data["failureReasonCode"] = reason_code

    def fail_once(self, reason_code: str) -> None:
        self.remember_failure(reason_code)
        self._write()

    def remember_rollback(self, result: str, reason_code: str | None = None) -> None:
        self.data["rollbackResult"] = result
        self.data["rollbackReasonCode"] = reason_code

    def rollback(self, result: str, reason_code: str | None = None) -> None:
        self.remember_rollback(result, reason_code)
        self._write()

    def persist_best_effort(self) -> bool:
        try:
            self._write()
        except Exception:
            return False
        return True


def new_evidence(
    run_id: str,
    level: int,
    application_source_sha: str,
    operational_source_sha: str,
    candidate_image: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": EVIDENCE_VERSION,
        "runId": run_id,
        "level": level,
        "startedAt": utc_now(),
        "endedAt": None,
        "applicationSourceSha": application_source_sha,
        "operationalSourceSha": operational_source_sha,
        "previousDigest": None,
        "candidateDigest": candidate_image,
        "migrationBefore": None,
        "migrationAfter": None,
        "checkpointResult": None,
        "health": [],
        "smoke": [],
        "observation": [],
        "result": "STARTED",
        "failureReasonCode": None,
        "rollbackResult": None,
        "rollbackReasonCode": None,
    }


def validate_redacted_evidence(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            require(
                SENSITIVE_KEY_PATTERN.fullmatch(str(key)) is None,
                "EVIDENCE_REDACTION_FAILED",
            )
            validate_redacted_evidence(child)
    elif isinstance(value, list):
        for child in value:
            validate_redacted_evidence(child)
    elif isinstance(value, str):
        require("bearer " not in value.lower(), "EVIDENCE_REDACTION_FAILED")


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


@dataclasses.dataclass(frozen=True)
class HttpResult:
    status: int
    headers: Mapping[str, Any]
    body: bytes


class RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Mapping[str, Any],
        new_url: str,
    ) -> None:
        raise DeployStop("FUNCTIONAL_SMOKE_REDIRECT_FORBIDDEN")


class SmokeClient:
    def __init__(self, credentials_path: Path, *, opener: Any | None = None, policy: MetadataPolicy = MetadataPolicy()):
        self.base = "https://app.agenciagenesismkt.com.br"
        self.origin = self.base
        self.credentials_path = credentials_path
        self.policy = policy
        self.cookies = http.cookiejar.CookieJar()
        self.opener = opener or urllib.request.build_opener(
            RejectRedirectHandler(),
            urllib.request.HTTPCookieProcessor(self.cookies),
        )

    def request(self, method: str, path: str, *, headers: Mapping[str, str] | None = None, payload: Mapping[str, Any] | None = None) -> HttpResult:
        require(path.startswith("/api/v1/") and not path.startswith("//"), "FUNCTIONAL_SMOKE_ORIGIN_DIVERGED")
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request_headers = {"Accept": "application/json", **dict(headers or {})}
        if data is not None:
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, headers=request_headers, method=method)
        try:
            with self.opener.open(request, timeout=15) as response:
                return HttpResult(response.status, response.headers, response.read())
        except (urllib.error.URLError, TimeoutError) as error:
            raise DeployStop("FUNCTIONAL_SMOKE_REQUEST_FAILED") from error

    @staticmethod
    def json_body(result: HttpResult, reason_code: str) -> Mapping[str, Any]:
        try:
            payload = json.loads(result.body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise DeployStop(reason_code) from error
        require(isinstance(payload, dict), reason_code)
        return payload

    @staticmethod
    def no_store(result: HttpResult) -> bool:
        return "no-store" in str(result.headers.get("Cache-Control", "")).lower()

    @staticmethod
    def set_cookies(result: HttpResult) -> list[str]:
        getter = getattr(result.headers, "get_all", None)
        if callable(getter):
            return list(getter("Set-Cookie") or [])
        raw = result.headers.get("Set-Cookie", [])
        return [raw] if isinstance(raw, str) else list(raw)

    @staticmethod
    def assert_host_cookie(header: str, name: str, *, http_only: bool, cleared: bool = False) -> None:
        lower = header.lower()
        require(header.startswith(f"{name}="), "SMOKE_COOKIE_INVALID")
        require("; secure" in lower and "; path=/" in lower and "domain=" not in lower, "SMOKE_COOKIE_INVALID")
        require("; samesite=lax" in lower, "SMOKE_COOKIE_INVALID")
        require(("; httponly" in lower) is http_only, "SMOKE_COOKIE_INVALID")
        if cleared:
            require(header.startswith(f"{name}=;") and ("max-age=0" in lower or "expires=" in lower), "SMOKE_COOKIE_INVALID")

    def full(self) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        csrf_result = self.request("GET", "/api/v1/auth/csrf")
        require(csrf_result.status == 200 and self.no_store(csrf_result), "SMOKE_CSRF_FAILED")
        csrf_payload = self.json_body(csrf_result, "SMOKE_CSRF_FAILED")
        token = csrf_payload.get("csrfToken")
        require(isinstance(token, str) and CSRF_PATTERN.fullmatch(token) is not None, "SMOKE_CSRF_FAILED")
        csrf_cookie = next((value for value in self.set_cookies(csrf_result) if value.startswith("__Host-genesis_csrf=")), None)
        require(csrf_cookie is not None and csrf_cookie.startswith(f"__Host-genesis_csrf={token};"), "SMOKE_CSRF_FAILED")
        self.assert_host_cookie(csrf_cookie, "__Host-genesis_csrf", http_only=False)
        records.append({"category": "csrf", "status": 200, "assertion": "PASS", "reasonCode": None})

        validate_regular_metadata(self.credentials_path, policy=self.policy, expected_mode=0o600, reason_code="SMOKE_CREDENTIALS_INVALID")
        credentials = safe_json(self.credentials_path, "SMOKE_CREDENTIALS_INVALID")
        require(isinstance(credentials, dict) and set(credentials) == {"email", "password"}, "SMOKE_CREDENTIALS_INVALID")
        require(all(isinstance(value, str) and value for value in credentials.values()), "SMOKE_CREDENTIALS_INVALID")
        login_result = self.request("POST", "/api/v1/auth/login", headers={"Origin": self.origin, "X-CSRF-Token": token}, payload=credentials)
        require(login_result.status == 200 and self.no_store(login_result), "SMOKE_LOGIN_FAILED")
        login = self.json_body(login_result, "SMOKE_LOGIN_FAILED")
        access_token = login.get("accessToken")
        require(isinstance(access_token, str) and access_token != "", "SMOKE_LOGIN_FAILED")
        require(login.get("tokenType") == "Bearer" and isinstance(login.get("expiresIn"), int) and login["expiresIn"] > 0, "SMOKE_LOGIN_FAILED")
        user = login.get("user")
        require(isinstance(user, dict) and UUID_PATTERN.fullmatch(str(user.get("id", ""))) is not None and user.get("status") == "active", "SMOKE_LOGIN_FAILED")
        refresh_cookie = next((value for value in self.set_cookies(login_result) if value.startswith("__Host-genesis_refresh=")), None)
        require(refresh_cookie is not None, "SMOKE_LOGIN_FAILED")
        self.assert_host_cookie(refresh_cookie, "__Host-genesis_refresh", http_only=True)
        records.append({"category": "login", "status": 200, "assertion": "PASS", "reasonCode": None})

        authorization = {"Authorization": f"Bearer {access_token}"}
        bootstrap_result = self.request("GET", "/api/v1/auth/bootstrap", headers=authorization)
        require(bootstrap_result.status == 200 and self.no_store(bootstrap_result), "SMOKE_BOOTSTRAP_FAILED")
        bootstrap = self.json_body(bootstrap_result, "SMOKE_BOOTSTRAP_FAILED")
        require(isinstance(bootstrap.get("user"), dict) and bootstrap["user"].get("id") == user["id"], "SMOKE_BOOTSTRAP_FAILED")
        organizations = bootstrap.get("organizations")
        require(isinstance(organizations, list) and organizations, "SMOKE_BOOTSTRAP_FAILED")
        organization = organizations[0]
        require(isinstance(organization, dict), "SMOKE_BOOTSTRAP_FAILED")
        require(UUID_PATTERN.fullmatch(str(organization.get("id", ""))) is not None, "SMOKE_BOOTSTRAP_FAILED")
        require(UUID_PATTERN.fullmatch(str(organization.get("membershipId", ""))) is not None, "SMOKE_BOOTSTRAP_FAILED")
        require(all(isinstance(organization.get(key), str) and organization[key] for key in ("name", "slug")), "SMOKE_BOOTSTRAP_FAILED")
        require(organization.get("role") in {"owner", "admin", "member"}, "SMOKE_BOOTSTRAP_FAILED")
        records.append({"category": "bootstrap", "status": 200, "assertion": "PASS", "reasonCode": None})

        kanban_result = self.request("GET", "/api/v1/leads/kanban?limit=20", headers={**authorization, "X-Organization-Id": organization["id"]})
        require(kanban_result.status == 200 and self.no_store(kanban_result), "SMOKE_KANBAN_FAILED")
        validate_kanban(self.json_body(kanban_result, "SMOKE_KANBAN_FAILED"))
        records.append({"category": "kanban", "status": 200, "assertion": "PASS", "reasonCode": None})

        logout_result = self.request("POST", "/api/v1/auth/logout", headers={"Origin": self.origin, "X-CSRF-Token": token, **authorization})
        require(logout_result.status == 204 and logout_result.body == b"" and self.no_store(logout_result), "SMOKE_LOGOUT_FAILED")
        logout_cookies = self.set_cookies(logout_result)
        for cookie_name, http_only in (("__Host-genesis_csrf", False), ("__Host-genesis_refresh", True)):
            header = next((value for value in logout_cookies if value.startswith(f"{cookie_name}=")), None)
            require(header is not None, "SMOKE_LOGOUT_FAILED")
            self.assert_host_cookie(header, cookie_name, http_only=http_only, cleared=True)
        records.append({"category": "logout", "status": 204, "assertion": "PASS", "reasonCode": None})
        return records

    def compatibility(self) -> list[dict[str, Any]]:
        result = self.request("GET", "/api/v1/auth/csrf")
        require(result.status == 200 and self.no_store(result), "ROLLBACK_SMOKE_FAILED")
        payload = self.json_body(result, "ROLLBACK_SMOKE_FAILED")
        require(isinstance(payload.get("csrfToken"), str) and CSRF_PATTERN.fullmatch(payload["csrfToken"]) is not None, "ROLLBACK_SMOKE_FAILED")
        return [{"category": "rollback-csrf", "status": 200, "assertion": "PASS", "reasonCode": None}]


def validate_kanban(payload: Mapping[str, Any]) -> None:
    require(payload.get("currency") == "BRL", "SMOKE_KANBAN_FAILED")
    try:
        dt.datetime.fromisoformat(str(payload.get("asOf", "")).replace("Z", "+00:00"))
    except ValueError as error:
        raise DeployStop("SMOKE_KANBAN_FAILED") from error
    require(DECIMAL_PATTERN.fullmatch(str(payload.get("expectedValueTotalMinor", ""))) is not None, "SMOKE_KANBAN_FAILED")
    require(isinstance(payload.get("withoutExpectedValue"), int) and payload["withoutExpectedValue"] >= 0, "SMOKE_KANBAN_FAILED")
    columns = payload.get("columns")
    require(isinstance(columns, list) and [column.get("stage") for column in columns if isinstance(column, dict)] == list(EXPECTED_STAGES), "SMOKE_KANBAN_FAILED")
    for column in columns:
        require(isinstance(column.get("total"), int) and column["total"] >= 0, "SMOKE_KANBAN_FAILED")
        require(DECIMAL_PATTERN.fullmatch(str(column.get("expectedValueTotalMinor", ""))) is not None, "SMOKE_KANBAN_FAILED")
        require(isinstance(column.get("withoutExpectedValue"), int) and column["withoutExpectedValue"] >= 0, "SMOKE_KANBAN_FAILED")
        require(isinstance(column.get("items"), list), "SMOKE_KANBAN_FAILED")
        for item in column["items"]:
            require(isinstance(item, dict) and item.get("status") == "active" and item.get("stage") == column["stage"], "SMOKE_KANBAN_FAILED")
        page = column.get("page")
        require(isinstance(page, dict) and page.get("limit") == 20 and (page.get("nextCursor") is None or isinstance(page.get("nextCursor"), str)), "SMOKE_KANBAN_FAILED")


def external_health(opener: Any | None = None) -> dict[str, Any]:
    request = urllib.request.Request("https://api.agenciagenesismkt.com.br/health", method="GET", headers={"Accept": "application/json"})
    try:
        with (opener or urllib.request).urlopen(request, timeout=15) as response:
            response.read()
            require(response.status == 200, "EXTERNAL_HEALTH_FAILED")
    except (urllib.error.URLError, TimeoutError) as error:
        raise DeployStop("EXTERNAL_HEALTH_FAILED") from error
    return {"category": "external", "status": 200, "assertion": "PASS", "reasonCode": None}


@dataclasses.dataclass(frozen=True)
class PreflightSnapshot:
    previous_image: str
    api: ContainerState
    postgres: ContainerState
    traefik: ContainerState
    postgres_id: str
    traefik_id: str


def validate_secret_metadata(paths: Iterable[Path], policy: MetadataPolicy) -> None:
    for path in paths:
        metadata = validate_regular_metadata(path, policy=policy, reason_code="SECRET_METADATA_DIVERGED")
        mode = stat.S_IMODE(metadata.st_mode)
        require(mode in {0o400, 0o440, 0o600, 0o640}, "SECRET_METADATA_DIVERGED")
        if mode in {0o440, 0o640}:
            require(metadata.st_gid == 70, "SECRET_METADATA_DIVERGED")
        elif policy.gid is not None:
            require(metadata.st_gid == policy.gid, "SECRET_METADATA_DIVERGED")


def preflight(
    runner: CommandRunner,
    paths: DeploymentPaths,
    application_source_sha: str,
    operational_source_sha: str,
    candidate_image: str,
    *,
    expected_hostname: str,
    minimum_free_bytes: int,
    policy: MetadataPolicy = MetadataPolicy(),
    probe_lock: bool = False,
) -> tuple[PreflightSnapshot, ComposeClient]:
    require(sys.platform.startswith("linux") and platform.machine().lower() in {"x86_64", "amd64"}, "HOST_PLATFORM_DIVERGED")
    require(platform.node() == expected_hostname, "HOSTNAME_DIVERGED")
    require(
        SHA_PATTERN.fullmatch(application_source_sha) is not None,
        "INVALID_APPLICATION_SOURCE_SHA",
    )
    values = verify_operational_integrity(
        paths,
        operational_source_sha,
        policy=policy,
    )
    current_pointer = read_pointer(paths.pointer, policy=policy)
    require(IMAGE_PATTERN.fullmatch(candidate_image) is not None, "INVALID_API_IMAGE")
    validate_secret_metadata(
        COMPOSE_SECRET_FILES,
        MetadataPolicy(uid=policy.uid, gid=None),
    )
    validate_regular_metadata(
        paths.registry_credentials,
        policy=policy,
        expected_mode=0o600,
        reason_code="REGISTRY_CREDENTIALS_INVALID",
    )
    validate_regular_metadata(
        paths.smoke_credentials,
        policy=policy,
        expected_mode=0o600,
        reason_code="SMOKE_CREDENTIALS_INVALID",
    )
    validate_regular_metadata(paths.release_evidence, policy=policy, expected_mode=0o600, reason_code="RELEASE_EVIDENCE_INVALID")
    prove_release_evidence(
        paths.release_evidence,
        application_source_sha,
        operational_source_sha,
        candidate_image,
        policy,
    )
    require(shutil.disk_usage(paths.deploy_root).free >= minimum_free_bytes, "INSUFFICIENT_DISK_SPACE")
    result = runner.run(
        ("docker", "volume", "inspect", "genesis-postgres-data"),
        env=docker_child_environment(),
        check=False,
        timeout_seconds=COMMAND_READ_TIMEOUT_SECONDS,
    )
    require(result.returncode == 0, "POSTGRES_VOLUME_UNAVAILABLE")
    compose = ComposeClient(runner, paths, values.keys())
    rendered_config = compose.render(current_pointer)
    api_id = compose.service_id("api")
    postgres_id = compose.service_id("postgres")
    traefik_id = compose.service_id("traefik")
    api = inspect_container(runner, api_id)
    postgres = inspect_container(runner, postgres_id)
    traefik = inspect_container(runner, traefik_id)
    require(api.status == "running" and api.health == "healthy", "API_NOT_HEALTHY")
    require(postgres.status == "running" and postgres.health == "healthy", "POSTGRES_NOT_HEALTHY")
    require(traefik.status == "running", "TRAEFIK_NOT_RUNNING")
    validate_pointer_runtime(current_pointer, api.image)
    require(
        postgres.image == rendered_config["services"]["postgres"]["image"],
        "POSTGRES_RUNTIME_IMAGE_DIVERGED",
    )
    require(
        traefik.image == rendered_config["services"]["traefik"]["image"],
        "TRAEFIK_RUNTIME_IMAGE_DIVERGED",
    )
    require(
        "genesis-postgres-data" in postgres.volumes,
        "POSTGRES_VOLUME_DIVERGED",
    )
    compose.migration_inventory(current_pointer)
    if probe_lock:
        probe_deployment_lock(paths.lock, policy)
    return PreflightSnapshot(current_pointer, api, postgres, traefik, postgres_id, traefik_id), compose


def run_checkpoint(runner: CommandRunner, paths: DeploymentPaths, run_id: str, policy: MetadataPolicy) -> None:
    validate_regular_metadata(paths.recovery_runner, policy=policy, reason_code="RECOVERY_TOOLING_INVALID")
    validate_regular_metadata(paths.recovery_env, policy=policy, reason_code="RECOVERY_TOOLING_INVALID")
    result = runner.run(
        (
            "/bin/bash",
            str(paths.recovery_runner),
            "--mode",
            "checkpoint",
            "--env-file",
            str(paths.recovery_env),
            "--run-id",
            run_id,
        ),
        env=docker_child_environment(),
        check=False,
        timeout_seconds=CHECKPOINT_TIMEOUT_SECONDS,
    )
    require(result.returncode == 0, "CHECKPOINT_FAILED")
    status_payload = safe_json(paths.recovery_status, "CHECKPOINT_FAILED")
    require(isinstance(status_payload, dict) and status_payload.get("operation") == "backup" and status_payload.get("outcome") == "passed" and status_payload.get("runId") == run_id, "CHECKPOINT_FAILED")


def verify_dependencies(compose: ComposeClient, snapshot: PreflightSnapshot) -> str:
    require(compose.service_id("postgres") == snapshot.postgres_id, "POSTGRES_CONTAINER_CHANGED")
    require(compose.service_id("traefik") == snapshot.traefik_id, "TRAEFIK_CONTAINER_CHANGED")
    return compose.service_id("api")


def assert_runtime_image(runner: CommandRunner, compose: ComposeClient, expected: str) -> ContainerState:
    state = inspect_container(runner, compose.service_id("api"))
    require(state.image == expected, "RUNTIME_IMAGE_DIVERGED")
    require(state.status == "running" and state.health == "healthy", "API_NOT_HEALTHY")
    return state


def traefik_log_has_5xx(source: str) -> bool:
    for raw_line in source.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise DeployStop("OBSERVABILITY_LOG_PARSE_FAILED") from error
        require(isinstance(record, dict), "OBSERVABILITY_LOG_PARSE_FAILED")
        for field in TRAEFIK_HTTP_STATUS_FIELDS:
            if field not in record:
                continue
            status_code = record[field]
            require(
                isinstance(status_code, int) and not isinstance(status_code, bool),
                "OBSERVABILITY_LOG_PARSE_FAILED",
            )
            if 500 <= status_code <= 599:
                return True
    return False


def observe(
    runner: CommandRunner,
    compose: ComposeClient,
    snapshot: PreflightSnapshot,
    candidate_image: str,
    level: int,
    smoke: SmokeClient,
    evidence: EvidenceStore,
    activation_time: str,
    *,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> None:
    started = monotonic()
    post_promotion = assert_runtime_image(runner, compose, candidate_image)
    require(post_promotion.restart_count == 0, "API_RESTART_COUNT_DIVERGED")
    for checkpoint in OBSERVATION_CHECKPOINTS[level]:
        wait = started + checkpoint - monotonic()
        if wait > 0:
            sleep(wait)
        current = assert_runtime_image(runner, compose, candidate_image)
        require(current.restart_count == post_promotion.restart_count, "API_RESTART_COUNT_DIVERGED")
        verify_dependencies(compose, snapshot)
        health_record = external_health()
        logs = runner.run(
            ("docker", "logs", "--since", activation_time, snapshot.traefik_id),
            env=docker_child_environment(),
            check=False,
            timeout_seconds=COMMAND_READ_TIMEOUT_SECONDS,
        )
        require(logs.returncode == 0, "TRAEFIK_LOG_CHECK_FAILED")
        combined_logs = f"{logs.stdout}\n{logs.stderr}"
        require(LOG_SENSITIVE_PATTERN.search(combined_logs) is None, "UNSANITIZED_RUNTIME_LOG")
        require(not traefik_log_has_5xx(combined_logs), "PERSISTENT_5XX")
        smoke_records = smoke.full()
        evidence.update(
            health=[*evidence.data["health"], health_record],
            smoke=[*evidence.data["smoke"], *smoke_records],
            observation=[*evidence.data["observation"], {"checkpointSeconds": checkpoint, "assertion": "PASS", "reasonCode": None}],
        )


def authorization_value(
    run_id: str,
    application_source_sha: str,
    operational_source_sha: str,
    candidate_image: str,
    level: int,
) -> str:
    return (
        f"{run_id}:{application_source_sha}:{operational_source_sha}:"
        f"{candidate_image}:{level}"
    )


def execute_deployment(
    runner: CommandRunner,
    paths: DeploymentPaths,
    *,
    run_id: str,
    application_source_sha: str,
    operational_source_sha: str,
    candidate_image: str,
    level: int,
    expected_pending: Sequence[str],
    authorization: str,
    expected_hostname: str,
    minimum_free_bytes: int,
    policy: MetadataPolicy = MetadataPolicy(),
    smoke_factory: Callable[[], SmokeClient] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    require(RUN_ID_PATTERN.fullmatch(run_id) is not None, "INVALID_RUN_ID")
    require(
        SHA_PATTERN.fullmatch(application_source_sha) is not None,
        "INVALID_APPLICATION_SOURCE_SHA",
    )
    require(
        SHA_PATTERN.fullmatch(operational_source_sha) is not None,
        "INVALID_OPERATIONAL_SOURCE_SHA",
    )
    require(level in {1, 2}, "LEVEL_3_REQUIRES_SEPARATE_ARCHITECTURE")
    require(
        authorization
        == authorization_value(
            run_id,
            application_source_sha,
            operational_source_sha,
            candidate_image,
            level,
        ),
        "PRODUCTION_MUTATION_NOT_AUTHORIZED",
    )
    paths.evidence_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    validate_safe_directory(paths.evidence_root, policy=policy)
    evidence = EvidenceStore(
        paths.evidence_root / f"{run_id}.json",
        new_evidence(
            run_id,
            level,
            application_source_sha,
            operational_source_sha,
            candidate_image,
        ),
        uid=policy.uid,
        gid=policy.gid,
    )
    promotion_started = False
    previous = None
    compose = None
    snapshot = None
    smoke = (smoke_factory or (lambda: SmokeClient(paths.smoke_credentials, policy=policy)))()
    try:
        with DeploymentLock(paths.lock, policy):
            snapshot, compose = preflight(
                runner,
                paths,
                application_source_sha,
                operational_source_sha,
                candidate_image,
                expected_hostname=expected_hostname,
                minimum_free_bytes=minimum_free_bytes,
                policy=policy,
            )
            previous = snapshot.previous_image
            evidence.update(previousDigest=previous)
            approved_pending = prove_release_evidence(
                paths.release_evidence,
                application_source_sha,
                operational_source_sha,
                candidate_image,
                policy,
            )
            prove_image(runner, previous, credentials_path=paths.registry_credentials, policy=policy)
            prove_image(
                runner,
                candidate_image,
                credentials_path=paths.registry_credentials,
                policy=policy,
                application_source_sha=application_source_sha,
            )
            compose.render(previous)
            if candidate_image == previous:
                evidence.update(result="NOOP", endedAt=utc_now())
                return evidence.data
            before_executed, pending = compose.migration_inventory(candidate_image)
            evidence.update(migrationBefore={"executed": list(before_executed), "pending": list(pending)})
            if level == 1:
                require(
                    not pending and not expected_pending and not approved_pending,
                    "LEVEL_1_PENDING_MIGRATIONS",
                )
            else:
                require(
                    expected_pending
                    and tuple(expected_pending) == approved_pending
                    and approved_pending == pending,
                    "LEVEL_2_PENDING_MISMATCH",
                )
                run_checkpoint(runner, paths, run_id, policy)
                evidence.update(checkpointResult="PASS")
                compose.migrate(candidate_image)
                after_executed, after_pending = compose.migration_inventory(candidate_image)
                validate_migration_inventory_after(
                    before_executed,
                    expected_pending,
                    after_executed,
                    after_pending,
                )
                evidence.update(migrationAfter={"executed": list(after_executed), "pending": list(after_pending)})
            activation_time = utc_now()
            promotion_started = True
            write_pointer(paths.pointer, candidate_image, uid=policy.uid, gid=policy.gid)
            require(
                read_pointer(paths.pointer, policy=policy) == candidate_image,
                "API_IMAGE_POINTER_UPDATE_FAILED",
            )
            compose.render(candidate_image)
            compose.recreate_api()
            new_api_id = verify_dependencies(compose, snapshot)
            require(new_api_id != snapshot.api.container_id, "API_CONTAINER_NOT_RECREATED")
            assert_runtime_image(runner, compose, candidate_image)
            smoke_records = smoke.full()
            evidence.update(smoke=smoke_records)
            observe(
                runner,
                compose,
                snapshot,
                candidate_image,
                level,
                smoke,
                evidence,
                activation_time,
                sleep=sleep,
                monotonic=monotonic,
            )
            evidence.update(result="KEEP", endedAt=utc_now())
            return evidence.data
    except Exception as error:
        reason_code = (
            error.reason_code
            if isinstance(error, DeployStop)
            else "UNEXPECTED_DEPLOYMENT_FAILURE"
        )
        # Runtime rollback has priority over audit persistence. Retain the first
        # cause in memory, complete rollback without evidence I/O, then make one
        # best-effort attempt to persist the terminal state.
        evidence.remember_failure(reason_code)
        if promotion_started and previous is not None and compose is not None and snapshot is not None:
            try:
                write_pointer(paths.pointer, previous, uid=policy.uid, gid=policy.gid)
                require(
                    read_pointer(paths.pointer, policy=policy) == previous,
                    "API_IMAGE_POINTER_ROLLBACK_FAILED",
                )
                compose.render(previous)
                compose.recreate_api()
                verify_dependencies(compose, snapshot)
                assert_runtime_image(runner, compose, previous)
                rollback_smoke = smoke.compatibility()
                evidence.data["smoke"] = [*evidence.data["smoke"], *rollback_smoke]
                evidence.remember_rollback("PASS")
                evidence.data.update(result="ROLLBACK", endedAt=utc_now())
            except Exception:
                evidence.remember_rollback("FAILED", "ROLLBACK_FAILED")
                evidence.data.update(result="ROLLBACK_FAILED", endedAt=utc_now())
        else:
            evidence.data.update(result="STOP", endedAt=utc_now())
        evidence.persist_best_effort()
        return evidence.data


def write_manifest_command(args: argparse.Namespace) -> int:
    manifest = build_operational_manifest(
        args.source_root,
        args.production_env,
        args.operational_source_sha,
        CommandRunner(),
    )
    payload = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    atomic_replace_bytes(args.output, payload, uid=args.uid, gid=args.gid)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="deploy-api-simple.py")
    subparsers = parser.add_subparsers(dest="command", required=True)
    manifest = subparsers.add_parser("manifest", help="create operational-integrity.json from exact source files")
    manifest.add_argument("--source-root", type=Path, required=True)
    manifest.add_argument("--production-env", type=Path, required=True)
    manifest.add_argument("--operational-source-sha", required=True)
    manifest.add_argument("--output", type=Path, required=True)
    manifest.add_argument("--uid", type=int, default=0)
    manifest.add_argument("--gid", type=int, default=0)

    for name in ("preflight", "execute"):
        command = subparsers.add_parser(name)
        command.add_argument("--application-source-sha", required=True)
        command.add_argument("--operational-source-sha", required=True)
        command.add_argument("--candidate-image", required=True)
        command.add_argument("--hostname", required=True)
        command.add_argument("--minimum-free-bytes", type=int, default=2 * 1024**3)
        if name == "execute":
            command.add_argument("--run-id", required=True)
            command.add_argument("--level", type=int, required=True)
            command.add_argument("--expected-pending", action="append", default=[])
            command.add_argument("--authorization", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "manifest":
            return write_manifest_command(args)
        runner = CommandRunner()
        if args.command == "preflight":
            snapshot, _compose = preflight(
                runner,
                DeploymentPaths(),
                args.application_source_sha,
                args.operational_source_sha,
                args.candidate_image,
                expected_hostname=args.hostname,
                minimum_free_bytes=args.minimum_free_bytes,
                probe_lock=True,
            )
            print(json.dumps({"result": "PASS", "previousDigest": snapshot.previous_image, "candidateDigest": args.candidate_image}, sort_keys=True))
            return 0
        result = execute_deployment(
            runner,
            DeploymentPaths(),
            run_id=args.run_id,
            application_source_sha=args.application_source_sha,
            operational_source_sha=args.operational_source_sha,
            candidate_image=args.candidate_image,
            level=args.level,
            expected_pending=args.expected_pending,
            authorization=args.authorization,
            expected_hostname=args.hostname,
            minimum_free_bytes=args.minimum_free_bytes,
        )
        print(json.dumps({key: value for key, value in result.items() if key not in {"health", "smoke", "observation"}}, sort_keys=True))
        return 0 if result["result"] in {"KEEP", "NOOP"} else 1
    except DeployStop as error:
        print(json.dumps({"result": "STOP", "reasonCode": error.reason_code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
