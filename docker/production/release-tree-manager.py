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
    return manifest, raw


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
        else:
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
