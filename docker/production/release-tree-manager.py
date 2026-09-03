#!/usr/bin/env python3
"""Fail-closed release-tree verifier and atomic exchange procedure.

The CLI is intentionally bound to /opt/genesis. Tests import the functions and
provide a disposable parent explicitly; no production path override is exposed.
"""

from __future__ import annotations

import argparse
import copy
import contextlib
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Callable, Iterable


BUNDLE_CONTRACT_VERSION = "0.8-MVP-08.v2"
TREE_CONTRACT_VERSION = "0.8-MVP-08.release-tree.v1"
RENAME_EXCHANGE = 2
AT_FDCWD = -100
RUN_ID_PATTERN = re.compile(r"^[a-f0-9]{16}$")
SHA256_PATTERN = re.compile(r"^sha256:[a-f0-9]{64}$")
IMAGE_PATTERN = re.compile(r"^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$")
EXPECTED_DIRECTORIES = [
    ".",
    "config",
    "config/recovery",
    "docker",
    "docker/postgres",
    "docker/production",
    "docker/recovery",
    "docker/recovery/systemd",
    "docker/traefik",
    "docker/traefik/dynamic",
    "docs",
]
PRESERVED_EXTERNAL_PATHS = [
    "/opt/genesis/recovery",
    "/opt/genesis/secrets",
    "/opt/genesis/traefik-state",
    "/var/lib/docker",
    "/var/lib/genesis/recovery",
]
BASELINE_REPAIR_PROFILE = "baseline-repair-09e"
BASELINE_REPAIR_CURRENT_APPLICATION = "0a56a8aee7c64bda59a1981888418e1ad03950c0"
BASELINE_REPAIR_CURRENT_IMAGE = (
    "ghcr.io/arthurportodev/genesis-platform-api@sha256:"
    "b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb"
)
BASELINE_REPAIR_CURRENT_CONFIG = (
    "sha256:1cd0615209cd0ac5b00b9b89754d525a1af9eead3d727f3397a98bfe33d08b24"
)
BASELINE_REPAIR_PREVIOUS_APPLICATION = "9402d067897ab727fb369d7e696a11ba3b9cf68f"
BASELINE_REPAIR_PREVIOUS_IMAGE = (
    "ghcr.io/arthurportodev/genesis-platform-api@sha256:"
    "a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a"
)
BASELINE_REPAIR_PREVIOUS_CONFIG = (
    "sha256:ba67e2ab1bb92d3486e9f37c602fd4c374330d54b2697b5b1bca79d925a96bd9"
)
BASELINE_REPAIR_OLD_FINGERPRINT = (
    "sha256:752084dda34619155617fb40b42c518ff3a1129ec30e7d22dbd0994d965d64b8"
)
BASELINE_REPAIR_BACKUP_PREFIX = ".genesis-release-baseline-repair-backup-"
BASELINE_REPAIR_PROBE_PREFIX = ".genesis-release-baseline-repair-probe-"
BASELINE_REPAIR_LEGACY_DIRECTORIES = {
    "deployment-state": "0755",
    "deployment-state/evidence": "0700",
    "deployment-state/overlays": "0755",
    "deployment-state/overlays/"
    "a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a": "0755",
    "deployment-state/overlays/"
    "b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb": "0755",
}
BASELINE_REPAIR_LEGACY_FILES = {
    "deployment-state/evidence/final.sanitized.log": (
        "0600",
        "275a5e2225f67bea45a9a3368ecebf48e63312129b7ea14de387f1e6ee29ee4a",
    ),
    "deployment-state/evidence/final.sanitized.log.sha256": (
        "0600",
        "3a7259ac6ef84b0a5a3c42e73d8d5aa5661aadfe59555fc8a435b8691ea9228a",
    ),
    "deployment-state/evidence/keep.sanitized.log": (
        "0600",
        "275a5e2225f67bea45a9a3368ecebf48e63312129b7ea14de387f1e6ee29ee4a",
    ),
    "deployment-state/evidence/keep.sanitized.log.sha256": (
        "0600",
        "de92ee66262a8ba2a4ec42f5717929fa7201fc35c41e5a71e4a6f7be38bea473",
    ),
    "deployment-state/evidence/render-diff.sanitized.json": (
        "0600",
        "cc2d19a1202570033ce34d87ef3ac7fc9c340aed854d0f87afe79f5ed265a5f0",
    ),
    "deployment-state/evidence/t-plus-0.sanitized.log": (
        "0600",
        "275a5e2225f67bea45a9a3368ecebf48e63312129b7ea14de387f1e6ee29ee4a",
    ),
    "deployment-state/evidence/t-plus-0.sanitized.log.sha256": (
        "0600",
        "6dc4b2e52331ea19d2f9042ee950d325dfc5507ee0e64397c9ebb233ca16df2b",
    ),
    "deployment-state/evidence/t-plus-10.sanitized.log": (
        "0600",
        "275a5e2225f67bea45a9a3368ecebf48e63312129b7ea14de387f1e6ee29ee4a",
    ),
    "deployment-state/evidence/t-plus-10.sanitized.log.sha256": (
        "0600",
        "f2d64fe6597c7f5029b6693db4580e50c8a94e6b634b04f6f8d24e369d91335d",
    ),
    "deployment-state/evidence/t-plus-15.sanitized.log": (
        "0600",
        "275a5e2225f67bea45a9a3368ecebf48e63312129b7ea14de387f1e6ee29ee4a",
    ),
    "deployment-state/evidence/t-plus-15.sanitized.log.sha256": (
        "0600",
        "5e942047e8c18305eac6d707e7c797657dcdde978c3b8fe13f87b511653db1ae",
    ),
    "deployment-state/evidence/t-plus-2.sanitized.log": (
        "0600",
        "275a5e2225f67bea45a9a3368ecebf48e63312129b7ea14de387f1e6ee29ee4a",
    ),
    "deployment-state/evidence/t-plus-2.sanitized.log.sha256": (
        "0600",
        "0db0e892fed6f3af1b0c3ae868cb906b6341d7976bbc4f17dab972f5f766ded4",
    ),
    "deployment-state/evidence/t-plus-5.sanitized.log": (
        "0600",
        "275a5e2225f67bea45a9a3368ecebf48e63312129b7ea14de387f1e6ee29ee4a",
    ),
    "deployment-state/evidence/t-plus-5.sanitized.log.sha256": (
        "0600",
        "9d5c76aa1a6a47cd7989f42746bdb61956af6fb70289ef1c78a39b2cf5bb6fd6",
    ),
    "deployment-state/overlays/"
    "a4dafefab191093ea7547e47ed09783cff2abb67b177cabd09aa07b94ac5797a/"
    "compose.api-image.json": (
        "0644",
        "1befc234188ed51be2a8b5a7dda4bc84bc02338f59f338c47f122adbf030f37d",
    ),
    "deployment-state/overlays/"
    "b45425d7f6ea63bde18e53195dab0ef0af43a84c55402a1ecc70321484e05feb/"
    "compose.api-image.json": (
        "0644",
        "a14b11d2dae445c7cb0717cc98d20bbf02fd422bf61020e53c856e3edc001361",
    ),
    "deployment-state/pointers.json": (
        "0644",
        "670f2ab7d46ba5f3bdf2b87bbde46c8a2cd5dd50b45ce91ee0b3fa4c98850312",
    ),
}
BASELINE_REPAIR_COMPANION_PAIRS = {
    "deployment-state/evidence/final.sanitized.log.sha256": (
        "deployment-state/evidence/final.sanitized.log"
    ),
    "deployment-state/evidence/keep.sanitized.log.sha256": (
        "deployment-state/evidence/keep.sanitized.log"
    ),
    "deployment-state/evidence/t-plus-0.sanitized.log.sha256": (
        "deployment-state/evidence/t-plus-0.sanitized.log"
    ),
    "deployment-state/evidence/t-plus-10.sanitized.log.sha256": (
        "deployment-state/evidence/t-plus-10.sanitized.log"
    ),
    "deployment-state/evidence/t-plus-15.sanitized.log.sha256": (
        "deployment-state/evidence/t-plus-15.sanitized.log"
    ),
    "deployment-state/evidence/t-plus-2.sanitized.log.sha256": (
        "deployment-state/evidence/t-plus-2.sanitized.log"
    ),
    "deployment-state/evidence/t-plus-5.sanitized.log.sha256": (
        "deployment-state/evidence/t-plus-5.sanitized.log"
    ),
}


class ContractError(RuntimeError):
    pass


class AtomicPrimitiveUnavailable(ContractError):
    pass


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _mode(value: os.stat_result) -> str:
    return f"{stat.S_IMODE(value.st_mode):04o}"


def _safe_relative(path: str) -> bool:
    if path == ".":
        return True
    candidate = Path(path)
    return (
        not candidate.is_absolute()
        and "\\" not in path
        and path == candidate.as_posix()
        and ".." not in candidate.parts
        and "." not in candidate.parts
        and all(part not in {"", ".", ".."} for part in candidate.parts)
    )


def _assert_non_sensitive_path(path: str) -> None:
    lowered = path.lower()
    parts = lowered.split("/")
    basename = parts[-1]
    forbidden_parts = {"secret", "secrets", "runtime", "runtime-state"}
    forbidden_suffixes = (
        ".age",
        ".dump",
        ".key",
        ".log",
        ".pem",
        ".pid",
        ".sqlite",
        ".sock",
    )
    if (
        any(part in forbidden_parts for part in parts)
        or basename == ".env"
        or (basename.startswith(".env.") and not basename.endswith(".example"))
        or basename in {"acme.json", "acme-staging.json", "credentials.json"}
        or basename.endswith(forbidden_suffixes)
    ):
        raise ContractError(f"secret/runtime path is forbidden in release bundle: {path}")


def _decode_mount_path(value: str) -> str:
    return (
        value.replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
    )


def _mount_points() -> set[str]:
    points: set[str] = set()
    with open("/proc/self/mountinfo", "r", encoding="utf-8") as source:
        for line in source:
            fields = line.rstrip("\n").split(" ")
            if len(fields) >= 5:
                points.add(os.path.normpath(_decode_mount_path(fields[4])))
    return points


def _assert_no_mount_boundary(root: Path) -> None:
    normalized = os.path.normpath(str(root.absolute()))
    prefix = normalized + os.sep
    matches = sorted(
        point
        for point in _mount_points()
        if point == normalized or point.startswith(prefix)
    )
    if matches:
        raise ContractError(f"mount boundary detected: {matches[0]}")


def _assert_no_acl(path: Path) -> None:
    try:
        attributes = os.listxattr(path, follow_symlinks=False)
    except OSError as error:
        raise ContractError(f"ACL metadata cannot be inspected: {path}: {error}") from error
    forbidden = sorted(
        name
        for name in attributes
        if name in {"system.posix_acl_access", "system.posix_acl_default"}
    )
    if forbidden:
        raise ContractError(f"ACL is not authorized: {path}: {forbidden[0]}")


def _read_regular(root: Path, relative: str) -> bytes:
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    opened = [root_fd]
    try:
        current = root_fd
        parts = relative.split("/")
        for part in parts[:-1]:
            current = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=current,
            )
            opened.append(current)
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=current
        )
        opened.append(descriptor)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ContractError(f"file is not a unique regular file: {relative}")
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


def _enumerate(root: Path) -> dict[str, os.stat_result]:
    result: dict[str, os.stat_result] = {".": os.lstat(root)}

    def visit(absolute: Path, relative: str) -> None:
        with os.scandir(absolute) as iterator:
            entries = sorted(iterator, key=lambda item: item.name)
        for entry in entries:
            path = f"{relative}/{entry.name}" if relative else entry.name
            metadata = entry.stat(follow_symlinks=False)
            result[path] = metadata
            if stat.S_ISDIR(metadata.st_mode):
                visit(Path(entry.path), path)

    visit(root, "")
    return result


def _expected_tree(manifest: dict) -> tuple[dict[str, dict], dict[str, dict]]:
    directories = manifest.get("directories")
    artifacts = manifest.get("artifacts")
    manifest_entry = manifest.get("manifestEntry")
    if not isinstance(directories, list) or not isinstance(artifacts, list):
        raise ContractError("manifest tree entries are absent")
    if not isinstance(manifest_entry, dict):
        raise ContractError("manifest entry contract is absent")
    directory_map = {entry.get("path"): entry for entry in directories}
    file_entries = [*artifacts, manifest_entry]
    file_map = {entry.get("path"): entry for entry in file_entries}
    if len(directory_map) != len(directories) or len(file_map) != len(file_entries):
        raise ContractError("manifest tree entries contain duplicates")
    return directory_map, file_map


def _validate_contract_shape(manifest: dict) -> None:
    if manifest.get("contractVersion") != BUNDLE_CONTRACT_VERSION:
        raise ContractError("bundle contract version mismatch")
    if manifest.get("releaseRole") not in {"current", "rollback"}:
        raise ContractError("release role is invalid")
    tree = manifest.get("releaseTree")
    if not isinstance(tree, dict) or tree.get("contractVersion") != TREE_CONTRACT_VERSION:
        raise ContractError("release-tree contract version mismatch")
    expected_tree = {
        "contractVersion": TREE_CONTRACT_VERSION,
        "parent": {
            "path": "/opt/genesis",
            "type": "directory",
            "owner": 0,
            "group": 0,
            "mode": "0755",
        },
        "active": {"path": "/opt/genesis/release"},
        "construction": {
            "stagingNamePrefix": ".genesis-release-staging-",
            "initialOwner": 0,
            "initialGroup": 0,
            "initialMode": "0700",
            "sourcePolicy": "canonical-bundle-only",
        },
        "rollback": {
            "siblingNamePrefix": ".genesis-release-rollback-",
            "sourcePolicy": "derived-previous-approved-image-committed-release-only",
            "writableByGroupOrOther": False,
        },
        "quarantine": {
            "marker": ".genesis-untrusted-release.json",
            "owner": 0,
            "group": 0,
            "mode": "0700",
            "deleteAutomatically": False,
            "eligibleForRollback": False,
        },
        "lock": {
            "path": "/run/lock/genesis-release-tree.lock",
            "owner": 0,
            "group": 0,
            "mode": "0600",
        },
        "activation": {
            "primitive": "renameat2",
            "flag": "RENAME_EXCHANGE",
            "requireSameDevice": True,
            "nonAtomicFallback": "forbidden",
        },
        "preservedExternalPaths": PRESERVED_EXTERNAL_PATHS,
    }
    if tree != expected_tree:
        raise ContractError("release-tree contract fields diverge")
    directories, files = _expected_tree(manifest)
    if list(directories) != EXPECTED_DIRECTORIES:
        raise ContractError("directory allowlist or order mismatch")
    for path, entry in directories.items():
        expected = {
            "path": path,
            "type": "directory",
            "owner": 0,
            "group": 0,
            "mode": "0755",
        }
        if entry != expected:
            raise ContractError(f"directory contract mismatch: {path}")
    for path, entry in files.items():
        if not _safe_relative(path) or path == ".":
            raise ContractError(f"unsafe file path: {path}")
        _assert_non_sensitive_path(path)
        required = {"path", "type", "owner", "group", "mode"}
        if not required.issubset(entry):
            raise ContractError(f"incomplete file contract: {path}")
        if entry["type"] != "file" or entry["owner"] != 0 or entry["group"] != 0:
            raise ContractError(f"file ownership contract mismatch: {path}")
        if not re.fullmatch(r"0[0-7]{3}", entry["mode"]):
            raise ContractError(f"file mode contract is invalid: {path}")
        parent = str(Path(path).parent).replace("\\", "/")
        if parent == "":
            parent = "."
        if parent not in directories:
            raise ContractError(f"file parent is not contracted: {path}")


def load_manifest(
    bundle: Path,
    expected_fingerprint: str,
    expected_image: str,
    expected_role: str,
) -> tuple[dict, bytes]:
    if not SHA256_PATTERN.fullmatch(expected_fingerprint):
        raise ContractError("expected bundle fingerprint is invalid")
    if not IMAGE_PATTERN.fullmatch(expected_image):
        raise ContractError("expected image binding is invalid")
    if expected_role not in {"current", "rollback"}:
        raise ContractError("expected release role is invalid")
    metadata = os.lstat(bundle)
    if not stat.S_ISDIR(metadata.st_mode):
        raise ContractError("bundle root must be a directory")
    raw = _read_regular(bundle, "release-manifest.json")
    if f"sha256:{_sha256(raw)}" != expected_fingerprint:
        raise ContractError("bundle fingerprint mismatch")
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ContractError(f"release manifest is invalid: {error}") from error
    _validate_contract_shape(manifest)
    if manifest.get("bundleMode") != "committed-release" or manifest.get("operational") is not True:
        raise ContractError("only committed operational releases may be installed")
    if manifest.get("releaseRole") != expected_role:
        raise ContractError("release role binding mismatch")
    if manifest.get("images", {}).get("api", {}).get("reference") != expected_image:
        raise ContractError("API image binding mismatch")
    rollback_reference = manifest.get("rollback", {}).get("api", {}).get("reference")
    if expected_role == "current" and rollback_reference == expected_image:
        raise ContractError("current and rollback image bindings are not distinct")
    if expected_role == "rollback":
        if manifest.get("images", {}).get("api", {}).get("relation") != "previous-approved":
            raise ContractError("rollback image relation is not previous-approved")
        if rollback_reference != expected_image:
            raise ContractError("rollback metadata does not bind the selected image")
    profile = manifest.get("releaseProfile")
    if profile is not None:
        if profile != BASELINE_REPAIR_PROFILE:
            raise ContractError("release profile is invalid")
        _validate_baseline_repair_manifest(manifest)
    return manifest, raw


def _validate_baseline_repair_manifest(manifest: dict) -> None:
    expected_fields = {
        "artifacts",
        "bundleMode",
        "contractVersion",
        "directories",
        "generatedAt",
        "generatedAtSemantics",
        "images",
        "manifestEntry",
        "migrations",
        "operational",
        "platform",
        "recovery",
        "releaseProfile",
        "releaseRole",
        "releaseTree",
        "rollback",
        "sourceCommit",
    }
    if set(manifest) != expected_fields:
        raise ContractError("baseline repair manifest fields are not closed")
    api = manifest.get("images", {}).get("api", {})
    previous = manifest.get("rollback", {}).get("api", {})
    if manifest.get("bundleMode") != "committed-release":
        raise ContractError("baseline repair must be a committed release")
    if manifest.get("releaseRole") != "current":
        raise ContractError("baseline repair must use the current release role")
    if api.get("relation") is not None:
        raise ContractError("baseline repair current image must not declare a relation")
    if (
        api.get("reference") != BASELINE_REPAIR_CURRENT_IMAGE
        or api.get("digest") != BASELINE_REPAIR_CURRENT_IMAGE.split("@", 1)[1]
        or api.get("applicationRevision") != BASELINE_REPAIR_CURRENT_APPLICATION
        or api.get("configDigest") != BASELINE_REPAIR_CURRENT_CONFIG
    ):
        raise ContractError("baseline repair current identity mismatch")
    if (
        previous.get("reference") != BASELINE_REPAIR_PREVIOUS_IMAGE
        or previous.get("digest") != BASELINE_REPAIR_PREVIOUS_IMAGE.split("@", 1)[1]
        or previous.get("applicationRevision")
        != BASELINE_REPAIR_PREVIOUS_APPLICATION
        or previous.get("configDigest") != BASELINE_REPAIR_PREVIOUS_CONFIG
        or previous.get("relation") != "previous-approved"
    ):
        raise ContractError("baseline repair previous-approved identity mismatch")


def validate_tree(
    root: Path,
    manifest: dict,
    manifest_raw: bytes,
    *,
    require_target_identity: bool,
    expected_device: int | None = None,
) -> dict:
    root_metadata = os.lstat(root)
    if not stat.S_ISDIR(root_metadata.st_mode):
        raise ContractError("tree root must be a real directory")
    _assert_no_mount_boundary(root)
    actual = _enumerate(root)
    directories, files = _expected_tree(manifest)
    expected_paths = set(directories) | set(files)
    if set(actual) != expected_paths:
        missing = sorted(expected_paths - set(actual))
        unexpected = sorted(set(actual) - expected_paths)
        raise ContractError(
            f"tree allowlist mismatch: missing={missing}; unexpected={unexpected}"
        )
    root_device = root_metadata.st_dev
    if expected_device is not None and root_device != expected_device:
        raise ContractError("tree is on a different filesystem")
    for path in sorted(actual):
        metadata = actual[path]
        expected = directories.get(path) or files.get(path)
        absolute = root if path == "." else root.joinpath(*path.split("/"))
        if metadata.st_dev != root_device:
            raise ContractError(f"filesystem boundary detected: {path}")
        _assert_no_acl(absolute)
        if expected["type"] == "directory":
            if not stat.S_ISDIR(metadata.st_mode):
                raise ContractError(f"type mismatch: {path}")
        else:
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise ContractError(f"file is not a unique regular file: {path}")
        if _mode(metadata) != expected["mode"]:
            raise ContractError(f"mode mismatch: {path}")
        if stat.S_IMODE(metadata.st_mode) & 0o022:
            raise ContractError(f"group/other writable entry: {path}")
        if require_target_identity and (
            metadata.st_uid != expected["owner"] or metadata.st_gid != expected["group"]
        ):
            raise ContractError(f"owner/group mismatch: {path}")
    for path, expected in files.items():
        content = _read_regular(root, path)
        if path == "release-manifest.json":
            if content != manifest_raw:
                raise ContractError("release manifest bytes diverge")
        elif _sha256(content) != expected.get("sha256"):
            raise ContractError(f"content hash mismatch: {path}")
    return {
        "status": "passed",
        "directories": len(directories),
        "files": len(files),
        "device": root_device,
    }


def _tree_fingerprint(root: Path, actual: dict[str, os.stat_result]) -> str:
    rows = []
    for path in sorted(actual):
        metadata = actual[path]
        if stat.S_ISDIR(metadata.st_mode):
            kind = "directory"
            content = None
        elif stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1:
            kind = "file"
            content = _sha256(_read_regular(root, path))
        else:
            raise ContractError(f"old active contains an irregular entry: {path}")
        rows.append(
            {
                "path": path,
                "type": kind,
                "owner": metadata.st_uid,
                "group": metadata.st_gid,
                "mode": _mode(metadata),
                "sha256": content,
            }
        )
    encoded = json.dumps(rows, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"sha256:{_sha256(encoded)}"


def _legacy_overlay_bytes(image: str) -> bytes:
    return json.dumps(
        {"services": {"api": {"image": image}}},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"


def validate_baseline_repair_old_tree(
    root: Path,
    expected_fingerprint: str,
    *,
    expected_device: int | None = None,
) -> dict:
    manifest, raw = load_manifest(
        root,
        expected_fingerprint,
        BASELINE_REPAIR_PREVIOUS_IMAGE,
        "current",
    )
    api = manifest.get("images", {}).get("api", {})
    if (
        api.get("applicationRevision") != BASELINE_REPAIR_PREVIOUS_APPLICATION
        or api.get("configDigest") != BASELINE_REPAIR_PREVIOUS_CONFIG
    ):
        raise ContractError("old active application/config identity mismatch")
    root_metadata = os.lstat(root)
    if not stat.S_ISDIR(root_metadata.st_mode):
        raise ContractError("old active root must be a real directory")
    _assert_no_mount_boundary(root)
    actual = _enumerate(root)
    directories, files = _expected_tree(manifest)
    expected_paths = set(directories) | set(files)
    missing = sorted(expected_paths - set(actual))
    if missing:
        raise ContractError(f"old active canonical tree is incomplete: {missing}")
    legacy_paths = set(BASELINE_REPAIR_LEGACY_DIRECTORIES) | set(
        BASELINE_REPAIR_LEGACY_FILES
    )
    exact_paths = expected_paths | legacy_paths
    missing = sorted(exact_paths - set(actual))
    if missing:
        raise ContractError(f"old active tree is incomplete: {missing}")
    unexpected = sorted(set(actual) - exact_paths)
    if unexpected:
        raise ContractError(f"old active contains an unexpected path: {unexpected}")
    root_device = root_metadata.st_dev
    if expected_device is not None and root_device != expected_device:
        raise ContractError("old active tree is on a different filesystem")
    for path in sorted(actual):
        metadata = actual[path]
        expected = directories.get(path) or files.get(path)
        absolute = root if path == "." else root.joinpath(*path.split("/"))
        _assert_no_acl(absolute)
        if metadata.st_dev != root_device:
            raise ContractError(f"filesystem boundary detected: {path}")
        if expected is not None:
            expected_type = expected["type"]
            expected_mode = expected["mode"]
            expected_owner = expected["owner"]
            expected_group = expected["group"]
        elif path in BASELINE_REPAIR_LEGACY_DIRECTORIES:
            expected_type = "directory"
            expected_mode = BASELINE_REPAIR_LEGACY_DIRECTORIES[path]
            expected_owner = 0
            expected_group = 0
        else:
            expected_type = "file"
            expected_mode = BASELINE_REPAIR_LEGACY_FILES[path][0]
            expected_owner = 0
            expected_group = 0
        if expected_type == "directory":
            if not stat.S_ISDIR(metadata.st_mode):
                raise ContractError(f"type mismatch: {path}")
        elif not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ContractError(f"file is not a unique regular file: {path}")
        if (
            _mode(metadata) != expected_mode
            or metadata.st_uid != expected_owner
            or metadata.st_gid != expected_group
        ):
            raise ContractError(f"old active metadata mismatch: {path}")
        if stat.S_IMODE(metadata.st_mode) & 0o022:
            raise ContractError(f"group/other writable entry: {path}")
    for path, expected in files.items():
        content = _read_regular(root, path)
        if path == "release-manifest.json":
            if content != raw:
                raise ContractError("old active manifest bytes diverge")
        elif _sha256(content) != expected.get("sha256"):
            raise ContractError(f"old active content hash mismatch: {path}")
    for path, (_, expected_hash) in BASELINE_REPAIR_LEGACY_FILES.items():
        if _sha256(_read_regular(root, path)) != expected_hash:
            raise ContractError(f"old active legacy content hash mismatch: {path}")
    for companion_path, log_path in BASELINE_REPAIR_COMPANION_PAIRS.items():
        companion = _read_regular(root, companion_path)
        try:
            decoded = companion.decode("ascii")
        except UnicodeDecodeError as error:
            raise ContractError(
                f"legacy companion is not ASCII: {companion_path}"
            ) from error
        match = re.fullmatch(r"([a-f0-9]{64})  ([a-z0-9-]+\.sanitized\.log)\n", decoded)
        if match is None:
            raise ContractError(f"legacy companion format mismatch: {companion_path}")
        if match.group(2) != Path(log_path).name:
            raise ContractError(f"legacy companion basename mismatch: {companion_path}")
        if match.group(1) != _sha256(_read_regular(root, log_path)):
            raise ContractError(f"legacy companion digest mismatch: {companion_path}")
    current_digest = BASELINE_REPAIR_CURRENT_IMAGE.rsplit(":", 1)[1]
    previous_digest = BASELINE_REPAIR_PREVIOUS_IMAGE.rsplit(":", 1)[1]
    current_overlay = (
        f"deployment-state/overlays/{current_digest}/compose.api-image.json"
    )
    previous_overlay = (
        f"deployment-state/overlays/{previous_digest}/compose.api-image.json"
    )
    if _read_regular(root, current_overlay) != _legacy_overlay_bytes(
        BASELINE_REPAIR_CURRENT_IMAGE
    ):
        raise ContractError("old active current overlay mismatch")
    if _read_regular(root, previous_overlay) != _legacy_overlay_bytes(
        BASELINE_REPAIR_PREVIOUS_IMAGE
    ):
        raise ContractError("old active previous overlay mismatch")
    try:
        pointers = json.loads(_read_regular(root, "deployment-state/pointers.json"))
    except json.JSONDecodeError as error:
        raise ContractError("old active pointer document is invalid") from error
    expected_pointers = {
        "schemaVersion": "1.0.0",
        "current": f"deployment-state/overlays/{current_digest}",
        "previous": f"deployment-state/overlays/{previous_digest}",
    }
    if pointers != expected_pointers:
        raise ContractError("old active pointer identity mismatch")
    return {
        "status": "passed",
        "device": root_device,
        "inode": root_metadata.st_ino,
        "manifestFingerprint": expected_fingerprint,
        "treeFingerprint": _tree_fingerprint(root, actual),
    }


def validate_bundle(
    bundle: Path, fingerprint: str, image: str, role: str
) -> tuple[dict, bytes]:
    manifest, raw = load_manifest(bundle, fingerprint, image, role)
    validate_tree(
        bundle,
        manifest,
        raw,
        require_target_identity=False,
    )
    return manifest, raw


def validate_rollback_pair(
    current_root: Path,
    current_manifest: dict,
    current_image: str,
    rollback_root: Path,
    rollback_manifest: dict,
    rollback_image: str,
) -> None:
    if current_manifest.get("sourceCommit") != rollback_manifest.get("sourceCommit"):
        raise ContractError("current and rollback source commits differ")
    current_artifacts = {
        entry.get("path"): entry for entry in current_manifest.get("artifacts", [])
    }
    rollback_artifacts = {
        entry.get("path"): entry for entry in rollback_manifest.get("artifacts", [])
    }
    if set(current_artifacts) != set(rollback_artifacts):
        raise ContractError("current and rollback artifact sets differ")
    for path in sorted(current_artifacts):
        if path == "compose.production.yml":
            continue
        if current_artifacts[path] != rollback_artifacts[path]:
            raise ContractError(f"non-Compose artifact metadata differs: {path}")
        if _read_regular(current_root, path) != _read_regular(rollback_root, path):
            raise ContractError(f"non-Compose artifact bytes differ: {path}")
    current_compose = _read_regular(current_root, "compose.production.yml")
    rollback_compose = _read_regular(rollback_root, "compose.production.yml")
    current_binding = current_image.encode("utf-8")
    rollback_binding = rollback_image.encode("utf-8")
    if current_compose.count(current_binding) != 2:
        raise ContractError("current Compose does not contain exactly two API bindings")
    if rollback_compose != current_compose.replace(current_binding, rollback_binding):
        raise ContractError("rollback Compose is not the exact approved image derivation")
    current_entry = next(
        (
            entry
            for entry in current_manifest.get("artifacts", [])
            if entry.get("path") == "compose.production.yml"
        ),
        None,
    )
    rollback_entry = next(
        (
            entry
            for entry in rollback_manifest.get("artifacts", [])
            if entry.get("path") == "compose.production.yml"
        ),
        None,
    )
    if not isinstance(current_entry, dict) or not isinstance(rollback_entry, dict):
        raise ContractError("Compose artifact metadata is absent")
    expected_derivation = {
        "kind": "exact-api-image-replacement",
        "sourceSha256": _sha256(current_compose),
        "from": current_image,
        "to": rollback_image,
        "replacements": 2,
    }
    if current_entry.get("derivation") is not None:
        raise ContractError("current Compose must not declare derivation metadata")
    if rollback_entry.get("derivation") != expected_derivation:
        raise ContractError("rollback Compose derivation metadata mismatch")
    normalized_rollback = copy.deepcopy(rollback_manifest)
    normalized_rollback["releaseRole"] = "current"
    normalized_rollback["images"]["api"] = copy.deepcopy(
        current_manifest["images"]["api"]
    )
    normalized_compose = next(
        entry
        for entry in normalized_rollback["artifacts"]
        if entry.get("path") == "compose.production.yml"
    )
    normalized_compose["sha256"] = current_entry.get("sha256")
    normalized_compose.pop("derivation", None)
    if normalized_rollback != current_manifest:
        raise ContractError(
            "rollback manifest differs outside the approved role/image/Compose derivation"
        )


def _write_regular(path: Path, content: bytes, mode: int) -> None:
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        mode,
    )
    try:
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def stage_bundle(
    bundle: Path,
    target: Path,
    fingerprint: str,
    image: str,
    role: str,
    *,
    expected_device: int,
) -> tuple[dict, bytes]:
    manifest, raw = validate_bundle(bundle, fingerprint, image, role)
    if target.exists() or target.is_symlink():
        raise ContractError(f"staging path already exists: {target}")
    os.mkdir(target, 0o700)
    os.chown(target, 0, 0)
    os.chmod(target, 0o700)
    if os.lstat(target).st_dev != expected_device:
        raise ContractError("staging path is on a different filesystem")
    directories, files = _expected_tree(manifest)
    for path in sorted(
        (item for item in directories if item != "."),
        key=lambda value: (value.count("/"), value),
    ):
        absolute = target.joinpath(*path.split("/"))
        os.mkdir(absolute, 0o700)
        os.chown(absolute, 0, 0)
        os.chmod(absolute, 0o700)
    for path in sorted(files):
        content = raw if path == "release-manifest.json" else _read_regular(bundle, path)
        expected = files[path]
        _write_regular(
            target.joinpath(*path.split("/")),
            content,
            int(expected["mode"], 8),
        )
    for path in sorted(
        (item for item in directories if item != "."),
        key=lambda value: (-value.count("/"), value),
    ):
        absolute = target.joinpath(*path.split("/"))
        os.chown(absolute, directories[path]["owner"], directories[path]["group"])
        os.chmod(absolute, int(directories[path]["mode"], 8))
        _fsync_directory(absolute)
    os.chown(target, directories["."]["owner"], directories["."]["group"])
    os.chmod(target, int(directories["."]["mode"], 8))
    _fsync_directory(target)
    validate_tree(
        target,
        manifest,
        raw,
        require_target_identity=True,
        expected_device=expected_device,
    )
    return manifest, raw


def _rename_exchange(left: Path, right: Path) -> None:
    library = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(library, "renameat2", None)
    arguments = (
        AT_FDCWD,
        os.fsencode(left),
        AT_FDCWD,
        os.fsencode(right),
        RENAME_EXCHANGE,
    )
    if renameat2 is not None:
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        result = renameat2(*arguments)
    else:
        numbers = {"x86_64": 316, "aarch64": 276}
        machine = os.uname().machine
        number = numbers.get(machine)
        if number is None:
            raise AtomicPrimitiveUnavailable("ATOMIC_PRIMITIVE_UNAVAILABLE")
        result = library.syscall(number, *arguments)
    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number in {errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP, errno.EXDEV}:
        raise AtomicPrimitiveUnavailable("ATOMIC_PRIMITIVE_UNAVAILABLE")
    raise OSError(error_number, os.strerror(error_number))


def _probe_exchange(
    current: Path,
    rollback: Path,
    current_contract: tuple[dict, bytes],
    rollback_contract: tuple[dict, bytes],
    device: int,
) -> None:
    _rename_exchange(current, rollback)
    _rename_exchange(current, rollback)
    validate_tree(
        current,
        current_contract[0],
        current_contract[1],
        require_target_identity=True,
        expected_device=device,
    )
    validate_tree(
        rollback,
        rollback_contract[0],
        rollback_contract[1],
        require_target_identity=True,
        expected_device=device,
    )


def _mark_untrusted(path: Path, run_id: str, reason: str) -> None:
    os.chown(path, 0, 0)
    os.chmod(path, 0o700)
    marker = path / ".genesis-untrusted-release.json"
    payload = json.dumps(
        {"state": "UNTRUSTED", "runId": run_id, "reason": reason},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    _write_regular(marker, payload, 0o600)
    _fsync_directory(path)


@contextlib.contextmanager
def _exclusive_lock(path: Path):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ContractError("release-tree lock is already held") from error
        yield
    finally:
        os.close(descriptor)


def _validate_parent(parent: Path) -> int:
    metadata = os.lstat(parent)
    if not stat.S_ISDIR(metadata.st_mode):
        raise ContractError("release parent must be a real directory")
    if metadata.st_uid != 0 or metadata.st_gid != 0 or _mode(metadata) != "0755":
        raise ContractError("release parent owner/group/mode mismatch")
    if stat.S_IMODE(metadata.st_mode) & 0o022:
        raise ContractError("release parent is writable by group/other")
    _assert_no_acl(parent)
    return metadata.st_dev


def _probe_baseline_repair_exchange(parent: Path, run_id: str, device: int) -> None:
    left = parent / f"{BASELINE_REPAIR_PROBE_PREFIX}{run_id}-left"
    right = parent / f"{BASELINE_REPAIR_PROBE_PREFIX}{run_id}-right"
    if left.exists() or left.is_symlink() or right.exists() or right.is_symlink():
        raise ContractError("baseline repair exchange probe path already exists")
    created = []
    try:
        os.mkdir(left, 0o700)
        created.append(left)
        os.mkdir(right, 0o700)
        created.append(right)
        for path in (left, right):
            os.chown(path, 0, 0)
            os.chmod(path, 0o700)
            if os.lstat(path).st_dev != device:
                raise ContractError("baseline repair exchange probe crossed filesystems")
        identities = {
            left: (os.lstat(left).st_dev, os.lstat(left).st_ino),
            right: (os.lstat(right).st_dev, os.lstat(right).st_ino),
        }
        _rename_exchange(left, right)
        _rename_exchange(left, right)
        for path, identity in identities.items():
            metadata = os.lstat(path)
            if (metadata.st_dev, metadata.st_ino) != identity:
                raise ContractError("baseline repair exchange probe identity mismatch")
    finally:
        for path in reversed(created):
            try:
                os.rmdir(path)
            except FileNotFoundError:
                pass


def _same_old_tree(left: dict, right: dict) -> bool:
    return all(
        left[key] == right[key]
        for key in ("device", "inode", "manifestFingerprint", "treeFingerprint")
    )


def repair_baseline(
    *,
    bundle: Path,
    new_fingerprint: str,
    current_image: str,
    expected_old_fingerprint: str,
    run_id: str,
    parent: Path = Path("/opt/genesis"),
    active: Path = Path("/opt/genesis/release"),
    lock_path: Path = Path("/run/lock/genesis-release-tree.lock"),
    after_exchange: Callable[[], None] | None = None,
) -> dict:
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise ContractError("run ID must contain exactly 16 lowercase hex characters")
    if active != parent / "release":
        raise ContractError("baseline repair active path is not contracted")
    if current_image != BASELINE_REPAIR_CURRENT_IMAGE:
        raise ContractError("baseline repair current image is not contracted")
    if expected_old_fingerprint != BASELINE_REPAIR_OLD_FINGERPRINT:
        raise ContractError("old active fingerprint is not the approved 09E baseline")
    new_contract = validate_bundle(bundle, new_fingerprint, current_image, "current")
    _validate_baseline_repair_manifest(new_contract[0])
    device = _validate_parent(parent)
    before = validate_baseline_repair_old_tree(
        active,
        expected_old_fingerprint,
        expected_device=device,
    )
    backup = parent / f"{BASELINE_REPAIR_BACKUP_PREFIX}{run_id}"
    if backup.exists() or backup.is_symlink():
        raise ContractError("baseline repair backup path already exists")
    with _exclusive_lock(lock_path):
        locked = validate_baseline_repair_old_tree(
            active,
            expected_old_fingerprint,
            expected_device=device,
        )
        if not _same_old_tree(before, locked):
            raise ContractError("old active tree changed before the release lock")
        if backup.exists() or backup.is_symlink():
            raise ContractError("baseline repair backup path already exists")
        staged = stage_bundle(
            bundle,
            backup,
            new_fingerprint,
            current_image,
            "current",
            expected_device=device,
        )
        _probe_baseline_repair_exchange(parent, run_id, device)
        final_old = validate_baseline_repair_old_tree(
            active,
            expected_old_fingerprint,
            expected_device=device,
        )
        if not _same_old_tree(before, final_old):
            raise ContractError("old active tree changed before atomic exchange")
        _fsync_directory(parent)
        _rename_exchange(active, backup)
        _fsync_directory(parent)
        try:
            if after_exchange is not None:
                after_exchange()
            validate_tree(
                active,
                staged[0],
                staged[1],
                require_target_identity=True,
                expected_device=device,
            )
            preserved = validate_baseline_repair_old_tree(
                backup,
                expected_old_fingerprint,
                expected_device=device,
            )
            if not _same_old_tree(before, preserved):
                raise ContractError("exact old active tree was not preserved")
        except Exception as repair_error:
            try:
                _rename_exchange(active, backup)
                _fsync_directory(parent)
                restored = validate_baseline_repair_old_tree(
                    active,
                    expected_old_fingerprint,
                    expected_device=device,
                )
                if not _same_old_tree(before, restored):
                    raise ContractError("old active identity was not restored")
            except Exception as restore_error:
                raise ContractError(
                    "baseline repair failed and exact automatic restore failed: "
                    f"{restore_error}"
                ) from repair_error
            raise ContractError(
                "baseline repair post-exchange validation failed; exact old active restored: "
                f"{repair_error}"
            ) from repair_error
        return {
            "status": "baseline-repaired",
            "active": str(active),
            "backup": str(backup),
            "backupIdentity": before["treeFingerprint"],
            "oldFingerprint": expected_old_fingerprint,
            "newFingerprint": new_fingerprint,
            "atomicPrimitive": "renameat2(RENAME_EXCHANGE)",
        }


def restore_baseline_repair(
    *,
    repaired_fingerprint: str,
    backup_identity: str,
    run_id: str,
    parent: Path = Path("/opt/genesis"),
    active: Path = Path("/opt/genesis/release"),
    lock_path: Path = Path("/run/lock/genesis-release-tree.lock"),
    after_exchange: Callable[[], None] | None = None,
) -> dict:
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise ContractError("run ID must contain exactly 16 lowercase hex characters")
    if not SHA256_PATTERN.fullmatch(backup_identity):
        raise ContractError("baseline repair backup identity is invalid")
    if active != parent / "release":
        raise ContractError("baseline repair active path is not contracted")
    backup = parent / f"{BASELINE_REPAIR_BACKUP_PREFIX}{run_id}"
    device = _validate_parent(parent)
    repaired_contract = validate_bundle(
        active,
        repaired_fingerprint,
        BASELINE_REPAIR_CURRENT_IMAGE,
        "current",
    )
    _validate_baseline_repair_manifest(repaired_contract[0])
    old = validate_baseline_repair_old_tree(
        backup,
        BASELINE_REPAIR_OLD_FINGERPRINT,
        expected_device=device,
    )
    if old["treeFingerprint"] != backup_identity:
        raise ContractError("baseline repair backup identity mismatch")
    with _exclusive_lock(lock_path):
        validate_tree(
            active,
            repaired_contract[0],
            repaired_contract[1],
            require_target_identity=True,
            expected_device=device,
        )
        locked_old = validate_baseline_repair_old_tree(
            backup,
            BASELINE_REPAIR_OLD_FINGERPRINT,
            expected_device=device,
        )
        if not _same_old_tree(old, locked_old):
            raise ContractError("baseline repair backup changed before restore")
        _probe_baseline_repair_exchange(parent, run_id, device)
        _fsync_directory(parent)
        _rename_exchange(active, backup)
        _fsync_directory(parent)
        try:
            if after_exchange is not None:
                after_exchange()
            restored = validate_baseline_repair_old_tree(
                active,
                BASELINE_REPAIR_OLD_FINGERPRINT,
                expected_device=device,
            )
            if not _same_old_tree(old, restored):
                raise ContractError("baseline repair backup was not restored exactly")
            validate_tree(
                backup,
                repaired_contract[0],
                repaired_contract[1],
                require_target_identity=True,
                expected_device=device,
            )
        except Exception as restore_error:
            try:
                _rename_exchange(active, backup)
                _fsync_directory(parent)
                validate_tree(
                    active,
                    repaired_contract[0],
                    repaired_contract[1],
                    require_target_identity=True,
                    expected_device=device,
                )
            except Exception as reverse_error:
                raise ContractError(
                    "baseline restore failed and repaired active could not be recovered: "
                    f"{reverse_error}"
                ) from restore_error
            raise ContractError(
                "baseline restore validation failed; repaired active restored: "
                f"{restore_error}"
            ) from restore_error
        return {
            "status": "baseline-repair-restored",
            "active": str(active),
            "repairedBackup": str(backup),
            "backupIdentity": backup_identity,
            "atomicPrimitive": "renameat2(RENAME_EXCHANGE)",
        }


def activate_release(
    *,
    current_bundle: Path,
    current_fingerprint: str,
    current_image: str,
    rollback_bundle: Path,
    rollback_fingerprint: str,
    rollback_image: str,
    run_id: str,
    parent: Path = Path("/opt/genesis"),
    active: Path = Path("/opt/genesis/release"),
    lock_path: Path = Path("/run/lock/genesis-release-tree.lock"),
    after_exchange: Callable[[], None] | None = None,
) -> dict:
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise ContractError("run ID must contain exactly 16 lowercase hex characters")
    if active.parent != parent:
        raise ContractError("active release must be an immediate child of the release parent")
    if current_fingerprint == rollback_fingerprint:
        raise ContractError("current and rollback bundle fingerprints must be distinct")
    if current_image == rollback_image:
        raise ContractError("current and rollback image bindings must be distinct")
    current_contract = validate_bundle(
        current_bundle, current_fingerprint, current_image, "current"
    )
    rollback_contract = validate_bundle(
        rollback_bundle, rollback_fingerprint, rollback_image, "rollback"
    )
    validate_rollback_pair(
        current_bundle,
        current_contract[0],
        current_image,
        rollback_bundle,
        rollback_contract[0],
        rollback_image,
    )
    device = _validate_parent(parent)
    active_metadata = os.lstat(active)
    if not stat.S_ISDIR(active_metadata.st_mode) or active_metadata.st_dev != device:
        raise ContractError("active release is irregular or on another filesystem")
    staging = parent / f".genesis-release-staging-{run_id}"
    rollback = parent / f".genesis-release-rollback-{run_id}"
    with _exclusive_lock(lock_path):
        current_staged = stage_bundle(
            current_bundle,
            staging,
            current_fingerprint,
            current_image,
            "current",
            expected_device=device,
        )
        rollback_staged = stage_bundle(
            rollback_bundle,
            rollback,
            rollback_fingerprint,
            rollback_image,
            "rollback",
            expected_device=device,
        )
        _probe_exchange(staging, rollback, current_staged, rollback_staged, device)
        _fsync_directory(parent)
        _rename_exchange(active, staging)
        _fsync_directory(parent)
        try:
            _mark_untrusted(staging, run_id, "previous-active-tree")
            if after_exchange is not None:
                after_exchange()
            validate_tree(
                active,
                current_staged[0],
                current_staged[1],
                require_target_identity=True,
                expected_device=device,
            )
        except Exception as activation_error:
            _rename_exchange(active, rollback)
            _fsync_directory(parent)
            _mark_untrusted(rollback, run_id, "failed-post-activation-tree")
            validate_tree(
                active,
                rollback_staged[0],
                rollback_staged[1],
                require_target_identity=True,
                expected_device=device,
            )
            raise ContractError(
                f"post-activation validation failed; verified rollback activated: {activation_error}"
            ) from activation_error
        return {
            "status": "activated",
            "active": str(active),
            "quarantine": str(staging),
            "rollback": str(rollback),
            "atomicPrimitive": "renameat2(RENAME_EXCHANGE)",
        }


def rollback_release(
    *,
    active_fingerprint: str,
    active_image: str,
    rollback_path: Path,
    rollback_fingerprint: str,
    rollback_image: str,
    run_id: str,
    parent: Path = Path("/opt/genesis"),
    active: Path = Path("/opt/genesis/release"),
    lock_path: Path = Path("/run/lock/genesis-release-tree.lock"),
) -> dict:
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise ContractError("run ID must contain exactly 16 lowercase hex characters")
    if rollback_path.parent != parent or not rollback_path.name.startswith(
        ".genesis-release-rollback-"
    ):
        raise ContractError("rollback path is outside the contracted sibling namespace")
    if active_fingerprint == rollback_fingerprint:
        raise ContractError("active and rollback bundle fingerprints must be distinct")
    if active_image == rollback_image:
        raise ContractError("active and rollback image bindings must be distinct")
    device = _validate_parent(parent)
    active_contract = load_manifest(
        active, active_fingerprint, active_image, "current"
    )
    rollback_contract = load_manifest(
        rollback_path, rollback_fingerprint, rollback_image, "rollback"
    )
    validate_tree(
        active,
        active_contract[0],
        active_contract[1],
        require_target_identity=True,
        expected_device=device,
    )
    validate_tree(
        rollback_path,
        rollback_contract[0],
        rollback_contract[1],
        require_target_identity=True,
        expected_device=device,
    )
    validate_rollback_pair(
        active,
        active_contract[0],
        active_image,
        rollback_path,
        rollback_contract[0],
        rollback_image,
    )
    with _exclusive_lock(lock_path):
        _rename_exchange(active, rollback_path)
        _fsync_directory(parent)
        try:
            validate_tree(
                active,
                rollback_contract[0],
                rollback_contract[1],
                require_target_identity=True,
                expected_device=device,
            )
        except Exception as rollback_error:
            _rename_exchange(active, rollback_path)
            _fsync_directory(parent)
            validate_tree(
                active,
                active_contract[0],
                active_contract[1],
                require_target_identity=True,
                expected_device=device,
            )
            raise ContractError(
                f"rollback validation failed; previous verified active restored: {rollback_error}"
            ) from rollback_error
        _mark_untrusted(rollback_path, run_id, "rolled-back-active-tree")
        return {
            "status": "rolled-back",
            "active": str(active),
            "quarantine": str(rollback_path),
            "atomicPrimitive": "renameat2(RENAME_EXCHANGE)",
        }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    verify = subcommands.add_parser("verify-bundle")
    verify.add_argument("--bundle", type=Path, required=True)
    verify.add_argument("--fingerprint", required=True)
    verify.add_argument("--expected-image", required=True)
    verify.add_argument(
        "--expected-role", choices=("current", "rollback"), required=True
    )
    pair = subcommands.add_parser("verify-pair")
    pair.add_argument("--current-bundle", type=Path, required=True)
    pair.add_argument("--current-fingerprint", required=True)
    pair.add_argument("--current-image", required=True)
    pair.add_argument("--rollback-bundle", type=Path, required=True)
    pair.add_argument("--rollback-fingerprint", required=True)
    pair.add_argument("--rollback-image", required=True)
    activate = subcommands.add_parser("activate")
    activate.add_argument("--current-bundle", type=Path, required=True)
    activate.add_argument("--current-fingerprint", required=True)
    activate.add_argument("--current-image", required=True)
    activate.add_argument("--rollback-bundle", type=Path, required=True)
    activate.add_argument("--rollback-fingerprint", required=True)
    activate.add_argument("--rollback-image", required=True)
    activate.add_argument("--run-id", required=True)
    rollback = subcommands.add_parser("rollback")
    rollback.add_argument("--active-fingerprint", required=True)
    rollback.add_argument("--active-image", required=True)
    rollback.add_argument("--rollback-path", type=Path, required=True)
    rollback.add_argument("--rollback-fingerprint", required=True)
    rollback.add_argument("--rollback-image", required=True)
    rollback.add_argument("--run-id", required=True)
    repair = subcommands.add_parser("repair-baseline")
    repair.add_argument("--bundle", type=Path, required=True)
    repair.add_argument("--new-fingerprint", required=True)
    repair.add_argument("--current-image", required=True)
    repair.add_argument("--expected-old-fingerprint", required=True)
    repair.add_argument("--run-id", required=True)
    restore = subcommands.add_parser("restore-baseline-repair")
    restore.add_argument("--repaired-fingerprint", required=True)
    restore.add_argument("--backup-identity", required=True)
    restore.add_argument("--run-id", required=True)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        if arguments.command == "verify-bundle":
            manifest, _ = validate_bundle(
                arguments.bundle,
                arguments.fingerprint,
                arguments.expected_image,
                arguments.expected_role,
            )
            result = {
                "status": "passed",
                "command": "verify-bundle",
                "sourceCommit": manifest.get("sourceCommit"),
                "releaseRole": manifest.get("releaseRole"),
            }
        elif arguments.command == "verify-pair":
            if arguments.current_fingerprint == arguments.rollback_fingerprint:
                raise ContractError(
                    "current and rollback bundle fingerprints must be distinct"
                )
            if arguments.current_image == arguments.rollback_image:
                raise ContractError("current and rollback image bindings must be distinct")
            current_contract = validate_bundle(
                arguments.current_bundle,
                arguments.current_fingerprint,
                arguments.current_image,
                "current",
            )
            rollback_contract = validate_bundle(
                arguments.rollback_bundle,
                arguments.rollback_fingerprint,
                arguments.rollback_image,
                "rollback",
            )
            validate_rollback_pair(
                arguments.current_bundle,
                current_contract[0],
                arguments.current_image,
                arguments.rollback_bundle,
                rollback_contract[0],
                arguments.rollback_image,
            )
            result = {
                "status": "passed",
                "command": "verify-pair",
                "currentRole": current_contract[0].get("releaseRole"),
                "rollbackRole": rollback_contract[0].get("releaseRole"),
            }
        elif arguments.command == "activate":
            if os.geteuid() != 0:
                raise ContractError("release-tree activation requires root")
            result = activate_release(
                current_bundle=arguments.current_bundle,
                current_fingerprint=arguments.current_fingerprint,
                current_image=arguments.current_image,
                rollback_bundle=arguments.rollback_bundle,
                rollback_fingerprint=arguments.rollback_fingerprint,
                rollback_image=arguments.rollback_image,
                run_id=arguments.run_id,
            )
        elif arguments.command == "rollback":
            if os.geteuid() != 0:
                raise ContractError("release-tree rollback requires root")
            result = rollback_release(
                active_fingerprint=arguments.active_fingerprint,
                active_image=arguments.active_image,
                rollback_path=arguments.rollback_path,
                rollback_fingerprint=arguments.rollback_fingerprint,
                rollback_image=arguments.rollback_image,
                run_id=arguments.run_id,
            )
        elif arguments.command == "repair-baseline":
            if os.geteuid() != 0:
                raise ContractError("baseline repair requires root")
            result = repair_baseline(
                bundle=arguments.bundle,
                new_fingerprint=arguments.new_fingerprint,
                current_image=arguments.current_image,
                expected_old_fingerprint=arguments.expected_old_fingerprint,
                run_id=arguments.run_id,
            )
        else:
            if os.geteuid() != 0:
                raise ContractError("baseline repair restore requires root")
            result = restore_baseline_repair(
                repaired_fingerprint=arguments.repaired_fingerprint,
                backup_identity=arguments.backup_identity,
                run_id=arguments.run_id,
            )
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except AtomicPrimitiveUnavailable:
        print("FAIL: ATOMIC_PRIMITIVE_UNAVAILABLE", file=sys.stderr)
        return 2
    except (ContractError, OSError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
