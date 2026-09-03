import errno
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
MANAGER_PATH = ROOT / "docker" / "production" / "release-tree-manager.py"
SPEC = importlib.util.spec_from_file_location("release_tree_manager", MANAGER_PATH)
MANAGER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MANAGER)

CURRENT_IMAGE = (
    "ghcr.io/arthurportodev/genesis-platform-api@sha256:"
    + "a" * 64
)
ROLLBACK_IMAGE = (
    "ghcr.io/arthurportodev/genesis-platform-api@sha256:"
    + "5" * 64
)


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def contract_tree(parent):
    return {
        "contractVersion": MANAGER.TREE_CONTRACT_VERSION,
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
        "preservedExternalPaths": MANAGER.PRESERVED_EXTERNAL_PATHS,
    }


def build_bundle(
    root,
    image,
    payload,
    release_role,
    *,
    release_profile=None,
    application_revision=None,
    config_digest=None,
    previous_image=ROLLBACK_IMAGE,
    previous_application=None,
    previous_config=None,
):
    root.mkdir(mode=0o755)
    os.chown(root, 0, 0)
    for relative in MANAGER.EXPECTED_DIRECTORIES[1:]:
        target = root.joinpath(*relative.split("/"))
        target.mkdir(mode=0o755)
        os.chown(target, 0, 0)
        os.chmod(target, 0o755)
    payload_path = root / "docs" / "payload.txt"
    payload_path.write_bytes(payload)
    os.chown(payload_path, 0, 0)
    os.chmod(payload_path, 0o644)
    compose_current_image = image if release_role == "current" else CURRENT_IMAGE
    current_compose = (
        f"services:\n  migrate:\n    image: {compose_current_image}\n"
        f"  api:\n    image: {compose_current_image}\n"
    ).encode()
    compose = (
        current_compose.replace(CURRENT_IMAGE.encode(), ROLLBACK_IMAGE.encode())
        if release_role == "rollback"
        else current_compose
    )
    compose_path = root / "compose.production.yml"
    compose_path.write_bytes(compose)
    os.chown(compose_path, 0, 0)
    os.chmod(compose_path, 0o644)
    directories = [
        {
            "path": path,
            "type": "directory",
            "owner": 0,
            "group": 0,
            "mode": "0755",
        }
        for path in MANAGER.EXPECTED_DIRECTORIES
    ]
    manifest = {
        "contractVersion": MANAGER.BUNDLE_CONTRACT_VERSION,
        "bundleMode": "committed-release",
        "releaseRole": release_role,
        "operational": True,
        "sourceCommit": "1" * 40,
        "images": {
            "api": {
                "reference": image,
                "digest": image.split("@", 1)[1],
                **(
                    {"applicationRevision": application_revision}
                    if application_revision is not None
                    else {}
                ),
                **(
                    {"configDigest": config_digest}
                    if config_digest is not None
                    else {}
                ),
                **(
                    {"relation": "previous-approved"}
                    if release_role == "rollback"
                    else {}
                ),
            }
        },
        "rollback": {
            "api": {
                "reference": previous_image,
                "digest": previous_image.split("@", 1)[1],
                **(
                    {"applicationRevision": previous_application}
                    if previous_application is not None
                    else {}
                ),
                **(
                    {"configDigest": previous_config}
                    if previous_config is not None
                    else {}
                ),
                **(
                    {"relation": "previous-approved"}
                    if release_profile is not None
                    else {}
                ),
            }
        },
        "releaseTree": contract_tree(root.parent),
        "directories": directories,
        "manifestEntry": {
            "path": "release-manifest.json",
            "type": "file",
            "owner": 0,
            "group": 0,
            "mode": "0644",
        },
        "artifacts": [
            {
                "path": "compose.production.yml",
                "sourcePath": "compose.production.yml",
                "type": "file",
                "owner": 0,
                "group": 0,
                "mode": "0644",
                "sha256": sha256(compose),
                **(
                    {
                        "derivation": {
                            "kind": "exact-api-image-replacement",
                            "sourceSha256": sha256(current_compose),
                            "from": CURRENT_IMAGE,
                            "to": ROLLBACK_IMAGE,
                            "replacements": 2,
                        }
                    }
                    if release_role == "rollback"
                    else {}
                ),
            },
            {
                "path": "docs/payload.txt",
                "sourcePath": "fixture/payload.txt",
                "type": "file",
                "owner": 0,
                "group": 0,
                "mode": "0644",
                "sha256": sha256(payload),
            }
        ],
    }
    if release_profile is not None:
        manifest["releaseProfile"] = release_profile
        manifest.update(
            {
                "generatedAt": "2026-09-02T00:00:00Z",
                "generatedAtSemantics": "source-commit-timestamp",
                "platform": "linux/amd64",
                "recovery": {},
                "migrations": {"sourcePath": "src/database/migrations", "orderedNames": []},
            }
        )
    raw = (json.dumps(manifest, indent=2) + "\n").encode()
    manifest_path = root / "release-manifest.json"
    manifest_path.write_bytes(raw)
    os.chown(manifest_path, 0, 0)
    os.chmod(manifest_path, 0o644)
    return "sha256:" + sha256(raw)


def add_legacy_09e_state(root):
    current_digest = MANAGER.BASELINE_REPAIR_CURRENT_IMAGE.rsplit(":", 1)[1]
    previous_digest = MANAGER.BASELINE_REPAIR_PREVIOUS_IMAGE.rsplit(":", 1)[1]
    state = root / "deployment-state"
    overlays = state / "overlays"
    evidence = state / "evidence"
    for path, mode in ((state, 0o755), (overlays, 0o755), (evidence, 0o700)):
        path.mkdir(mode=mode)
        os.chown(path, 0, 0)
        os.chmod(path, mode)
    legacy_files = {}

    def write_legacy(path, content, mode):
        path.write_bytes(content)
        os.chown(path, 0, 0)
        os.chmod(path, mode)
        relative = path.relative_to(root).as_posix()
        legacy_files[relative] = (f"{mode:04o}", sha256(content))

    for digest, image in (
        (current_digest, MANAGER.BASELINE_REPAIR_CURRENT_IMAGE),
        (previous_digest, MANAGER.BASELINE_REPAIR_PREVIOUS_IMAGE),
    ):
        directory = overlays / digest
        directory.mkdir(mode=0o755)
        os.chown(directory, 0, 0)
        os.chmod(directory, 0o755)
        overlay = directory / "compose.api-image.json"
        write_legacy(overlay, MANAGER._legacy_overlay_bytes(image), 0o644)
    pointers = state / "pointers.json"
    write_legacy(
        pointers,
        (
            json.dumps(
            {
                "schemaVersion": "1.0.0",
                "current": f"deployment-state/overlays/{current_digest}",
                "previous": f"deployment-state/overlays/{previous_digest}",
            },
            separators=(",", ":"),
        )
            + "\n"
        ).encode(),
        0o644,
    )
    sanitized = b"synthetic sanitized evidence\n"
    sanitized_hash = sha256(sanitized)
    for name in (
        "final",
        "keep",
        "t-plus-0",
        "t-plus-10",
        "t-plus-15",
        "t-plus-2",
        "t-plus-5",
    ):
        log = evidence / f"{name}.sanitized.log"
        write_legacy(log, sanitized, 0o600)
        companion = evidence / f"{name}.sanitized.log.sha256"
        write_legacy(
            companion,
            f"{sanitized_hash}  {log.name}\n".encode("ascii"),
            0o600,
        )
    write_legacy(
        evidence / "render-diff.sanitized.json",
        b'{"status":"synthetic"}\n',
        0o600,
    )
    return legacy_files


def copy_tree(source, target):
    shutil.copytree(source, target, copy_function=shutil.copy2)
    for current, directories, files in os.walk(target):
        os.chown(current, 0, 0)
        os.chmod(current, 0o755)
        for name in files:
            os.chown(Path(current) / name, 0, 0)
            os.chmod(Path(current) / name, 0o644)


def rewrite_manifest(root, mutate):
    manifest_path = root / "release-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    mutate(manifest)
    raw = (json.dumps(manifest, indent=2) + "\n").encode()
    manifest_path.write_bytes(raw)
    os.chown(manifest_path, 0, 0)
    os.chmod(manifest_path, 0o644)
    return "sha256:" + sha256(raw)


class ReleaseTreeManagerTests(unittest.TestCase):
    def setUp(self):
        if os.name != "posix" or os.geteuid() != 0:
            self.skipTest("requires a root Linux disposable filesystem")
        self.temp = tempfile.TemporaryDirectory(prefix="genesis-release-tree-")
        self.root = Path(self.temp.name)
        self.parent = self.root / "genesis"
        self.parent.mkdir(mode=0o755)
        os.chown(self.parent, 0, 0)
        os.chmod(self.parent, 0o755)
        self.active = self.parent / "release"
        self.active.mkdir(mode=0o777)
        os.chown(self.active, 0, 0)
        os.chmod(self.active, 0o777)
        (self.active / "legacy.txt").write_text("untrusted\n", encoding="utf-8")
        self.current_bundle = self.root / "current-bundle"
        self.rollback_bundle = self.root / "rollback-bundle"
        self.current_fingerprint = build_bundle(
            self.current_bundle, CURRENT_IMAGE, b"current\n", "current"
        )
        self.rollback_fingerprint = build_bundle(
            self.rollback_bundle, ROLLBACK_IMAGE, b"current\n", "rollback"
        )
        self.lock = self.root / "release.lock"

    def tearDown(self):
        self.temp.cleanup()

    def activate(self, **overrides):
        arguments = {
            "current_bundle": self.current_bundle,
            "current_fingerprint": self.current_fingerprint,
            "current_image": CURRENT_IMAGE,
            "rollback_bundle": self.rollback_bundle,
            "rollback_fingerprint": self.rollback_fingerprint,
            "rollback_image": ROLLBACK_IMAGE,
            "run_id": "0123456789abcdef",
            "parent": self.parent,
            "active": self.active,
            "lock_path": self.lock,
        }
        arguments.update(overrides)
        return MANAGER.activate_release(**arguments)

    def verify_bundle(
        self, root=None, fingerprint=None, image=CURRENT_IMAGE, role="current"
    ):
        root = root or self.current_bundle
        fingerprint = fingerprint or self.current_fingerprint
        manifest, raw = MANAGER.load_manifest(root, fingerprint, image, role)
        return MANAGER.validate_tree(
            root,
            manifest,
            raw,
            require_target_identity=True,
        )

    def prepare_baseline_repair(self):
        shutil.rmtree(self.active)
        old_fingerprint = build_bundle(
            self.active,
            MANAGER.BASELINE_REPAIR_PREVIOUS_IMAGE,
            b"historical-current\n",
            "current",
            application_revision=MANAGER.BASELINE_REPAIR_PREVIOUS_APPLICATION,
            config_digest=MANAGER.BASELINE_REPAIR_PREVIOUS_CONFIG,
        )
        legacy_files = add_legacy_09e_state(self.active)
        legacy_files_patcher = mock.patch.object(
            MANAGER, "BASELINE_REPAIR_LEGACY_FILES", legacy_files
        )
        legacy_files_patcher.start()
        self.addCleanup(legacy_files_patcher.stop)
        repair_bundle = self.root / "baseline-repair-bundle"
        repair_fingerprint = build_bundle(
            repair_bundle,
            MANAGER.BASELINE_REPAIR_CURRENT_IMAGE,
            b"canonical-live-current\n",
            "current",
            release_profile=MANAGER.BASELINE_REPAIR_PROFILE,
            application_revision=MANAGER.BASELINE_REPAIR_CURRENT_APPLICATION,
            config_digest=MANAGER.BASELINE_REPAIR_CURRENT_CONFIG,
            previous_image=MANAGER.BASELINE_REPAIR_PREVIOUS_IMAGE,
            previous_application=MANAGER.BASELINE_REPAIR_PREVIOUS_APPLICATION,
            previous_config=MANAGER.BASELINE_REPAIR_PREVIOUS_CONFIG,
        )
        return old_fingerprint, repair_bundle, repair_fingerprint

    def repair_baseline(self, old_fingerprint, repair_bundle, repair_fingerprint, **overrides):
        arguments = {
            "bundle": repair_bundle,
            "new_fingerprint": repair_fingerprint,
            "current_image": MANAGER.BASELINE_REPAIR_CURRENT_IMAGE,
            "expected_old_fingerprint": old_fingerprint,
            "run_id": "abcdef0123456789",
            "parent": self.parent,
            "active": self.active,
            "lock_path": self.lock,
        }
        arguments.update(overrides)
        with mock.patch.object(
            MANAGER, "BASELINE_REPAIR_OLD_FINGERPRINT", old_fingerprint
        ):
            return MANAGER.repair_baseline(**arguments)

    def clone_legacy_tree(self, name):
        target = self.root / name
        shutil.copytree(self.active, target, copy_function=shutil.copy2)
        return target

    def test_verifier_is_idempotent_and_rejects_0777(self):
        self.assertEqual(self.verify_bundle(), self.verify_bundle())
        os.chmod(self.current_bundle, 0o777)
        with self.assertRaisesRegex(MANAGER.ContractError, "mode mismatch"):
            self.verify_bundle()

    def test_rejects_swapped_release_roles(self):
        with self.assertRaisesRegex(MANAGER.ContractError, "release role binding"):
            self.verify_bundle(role="rollback")
        with self.assertRaisesRegex(MANAGER.ContractError, "release role binding"):
            self.verify_bundle(
                root=self.rollback_bundle,
                fingerprint=self.rollback_fingerprint,
                image=ROLLBACK_IMAGE,
                role="current",
            )
        with self.assertRaisesRegex(MANAGER.ContractError, "fingerprints must be distinct"):
            self.activate(rollback_fingerprint=self.current_fingerprint)
        with self.assertRaisesRegex(MANAGER.ContractError, "image bindings must be distinct"):
            self.activate(rollback_image=CURRENT_IMAGE)

    def test_rejects_non_compose_rollback_drift_and_different_source(self):
        payload = self.rollback_bundle / "docs" / "payload.txt"
        payload.write_text("divergent\n", encoding="utf-8")
        os.chown(payload, 0, 0)
        os.chmod(payload, 0o644)

        def bind_payload(manifest):
            next(
                entry
                for entry in manifest["artifacts"]
                if entry["path"] == "docs/payload.txt"
            )["sha256"] = sha256(payload.read_bytes())

        drift_fingerprint = rewrite_manifest(self.rollback_bundle, bind_payload)
        with self.assertRaisesRegex(
            MANAGER.ContractError, "non-Compose artifact metadata differs"
        ):
            self.activate(rollback_fingerprint=drift_fingerprint)

        shutil.rmtree(self.rollback_bundle)
        self.rollback_fingerprint = build_bundle(
            self.rollback_bundle, ROLLBACK_IMAGE, b"current\n", "rollback"
        )
        different_source = rewrite_manifest(
            self.rollback_bundle,
            lambda manifest: manifest.__setitem__("sourceCommit", "2" * 40),
        )
        with self.assertRaisesRegex(MANAGER.ContractError, "source commits differ"):
            self.activate(rollback_fingerprint=different_source)

    def test_rejects_owner_group_and_content_drift(self):
        payload = self.current_bundle / "docs" / "payload.txt"
        os.chown(payload, 1, 1)
        with self.assertRaisesRegex(MANAGER.ContractError, "owner/group mismatch"):
            self.verify_bundle()
        os.chown(payload, 0, 0)
        payload.write_text("changed\n", encoding="utf-8")
        with self.assertRaisesRegex(MANAGER.ContractError, "content hash mismatch"):
            self.verify_bundle()

    def test_rejects_symlink_hardlink_and_unexpected_file(self):
        payload = self.current_bundle / "docs" / "payload.txt"
        payload.unlink()
        payload.symlink_to(self.current_bundle / "release-manifest.json")
        with self.assertRaisesRegex(MANAGER.ContractError, "unique regular file"):
            self.verify_bundle()
        payload.unlink()
        os.link(self.current_bundle / "release-manifest.json", payload)
        with self.assertRaisesRegex(MANAGER.ContractError, "unique regular file"):
            self.verify_bundle()
        payload.unlink()
        payload.write_text("current\n", encoding="utf-8")
        os.chown(payload, 0, 0)
        os.chmod(payload, 0o644)
        (self.current_bundle / "unexpected.txt").write_text("unexpected\n")
        with self.assertRaisesRegex(MANAGER.ContractError, "allowlist mismatch"):
            self.verify_bundle()

    def test_rejects_special_file_mount_boundary_and_sensitive_manifest_path(self):
        payload = self.current_bundle / "docs" / "payload.txt"
        payload.unlink()
        os.mkfifo(payload, 0o644)
        with self.assertRaisesRegex(MANAGER.ContractError, "unique regular file"):
            self.verify_bundle()
        payload.unlink()
        payload.write_text("current\n", encoding="utf-8")
        os.chown(payload, 0, 0)
        os.chmod(payload, 0o644)
        with mock.patch.object(
            MANAGER, "_mount_points", return_value={str(self.current_bundle)}
        ):
            with self.assertRaisesRegex(MANAGER.ContractError, "mount boundary"):
                self.verify_bundle()
        manifest, _ = MANAGER.load_manifest(
            self.current_bundle, self.current_fingerprint, CURRENT_IMAGE, "current"
        )
        manifest["artifacts"][0]["path"] = "secrets/runtime.key"
        with self.assertRaisesRegex(MANAGER.ContractError, "secret/runtime path"):
            MANAGER._validate_contract_shape(manifest)

    def test_rejects_acl(self):
        payload = self.current_bundle / "docs" / "payload.txt"
        undefined = 0xFFFFFFFF
        value = struct.pack("<I", 2) + b"".join(
            [
                struct.pack("<HHI", 0x01, 0x07, undefined),
                struct.pack("<HHI", 0x02, 0x02, 12345),
                struct.pack("<HHI", 0x04, 0x05, undefined),
                struct.pack("<HHI", 0x10, 0x07, undefined),
                struct.pack("<HHI", 0x20, 0x05, undefined),
            ]
        )
        try:
            os.setxattr(payload, "system.posix_acl_access", value)
        except OSError as error:
            if error.errno in {errno.ENOTSUP, errno.EOPNOTSUPP}:
                self.skipTest("filesystem does not support POSIX ACL xattrs")
            raise
        with self.assertRaisesRegex(MANAGER.ContractError, "ACL is not authorized"):
            self.verify_bundle()

    def test_rejects_incomplete_staging(self):
        staging = self.parent / ".genesis-release-staging-fedcba9876543210"
        manifest, raw = MANAGER.stage_bundle(
            self.current_bundle,
            staging,
            self.current_fingerprint,
            CURRENT_IMAGE,
            "current",
            expected_device=os.lstat(self.parent).st_dev,
        )
        (staging / "docs" / "payload.txt").unlink()
        with self.assertRaisesRegex(MANAGER.ContractError, "allowlist mismatch"):
            MANAGER.validate_tree(
                staging,
                manifest,
                raw,
                require_target_identity=True,
            )

    def test_lock_contention_fails_before_staging(self):
        with MANAGER._exclusive_lock(self.lock):
            with self.assertRaisesRegex(MANAGER.ContractError, "lock is already held"):
                self.activate()
        self.assertTrue((self.active / "legacy.txt").is_file())

    def test_failure_before_exchange_preserves_active(self):
        (self.current_bundle / "docs" / "payload.txt").write_text(
            "invalid\n", encoding="utf-8"
        )
        with self.assertRaisesRegex(MANAGER.ContractError, "content hash mismatch"):
            self.activate()
        self.assertEqual((self.active / "legacy.txt").read_text(), "untrusted\n")

    def test_atomic_activation_quarantines_old_tree_and_preserves_external_state(self):
        preserved = []
        for name in ["secrets", "recovery", "traefik-state"]:
            directory = self.parent / name
            directory.mkdir()
            sentinel = directory / "sentinel"
            sentinel.write_text(name, encoding="utf-8")
            preserved.append((sentinel, sha256(sentinel.read_bytes())))
        result = self.activate()
        self.assertEqual((self.active / "docs" / "payload.txt").read_text(), "current\n")
        quarantine = Path(result["quarantine"])
        self.assertEqual(stat.S_IMODE(os.lstat(quarantine).st_mode), 0o700)
        marker = json.loads(
            (quarantine / ".genesis-untrusted-release.json").read_text()
        )
        self.assertEqual(marker["state"], "UNTRUSTED")
        for sentinel, expected in preserved:
            self.assertEqual(sha256(sentinel.read_bytes()), expected)

    def test_failure_after_exchange_activates_verified_rollback(self):
        def fail():
            raise RuntimeError("injected post-exchange failure")

        with self.assertRaisesRegex(
            MANAGER.ContractError, "verified rollback activated"
        ):
            self.activate(after_exchange=fail)
        self.assertEqual(
            json.loads((self.active / "release-manifest.json").read_text())[
                "releaseRole"
            ],
            "rollback",
        )
        self.assertEqual(
            (self.active / "compose.production.yml")
            .read_text()
            .count(ROLLBACK_IMAGE),
            2,
        )

    def test_atomic_rollback_uses_verified_sibling(self):
        activated = self.activate()
        result = MANAGER.rollback_release(
            active_fingerprint=self.current_fingerprint,
            active_image=CURRENT_IMAGE,
            rollback_path=Path(activated["rollback"]),
            rollback_fingerprint=self.rollback_fingerprint,
            rollback_image=ROLLBACK_IMAGE,
            run_id="0123456789abcdef",
            parent=self.parent,
            active=self.active,
            lock_path=self.lock,
        )
        self.assertEqual(result["status"], "rolled-back")
        self.assertEqual(
            json.loads((self.active / "release-manifest.json").read_text())[
                "releaseRole"
            ],
            "rollback",
        )

    def test_atomic_primitive_unavailable_has_no_fallback(self):
        with mock.patch.object(
            MANAGER,
            "_rename_exchange",
            side_effect=MANAGER.AtomicPrimitiveUnavailable(
                "ATOMIC_PRIMITIVE_UNAVAILABLE"
            ),
        ):
            with self.assertRaisesRegex(
                MANAGER.AtomicPrimitiveUnavailable,
                "ATOMIC_PRIMITIVE_UNAVAILABLE",
            ):
                self.activate()
        self.assertTrue((self.active / "legacy.txt").is_file())

    def test_baseline_repair_preserves_exact_old_tree_and_restores_it_atomically(self):
        old_fingerprint, repair_bundle, repair_fingerprint = (
            self.prepare_baseline_repair()
        )
        original = MANAGER.validate_baseline_repair_old_tree(
            self.active, old_fingerprint
        )
        result = self.repair_baseline(
            old_fingerprint, repair_bundle, repair_fingerprint
        )
        self.assertEqual(result["status"], "baseline-repaired")
        self.assertEqual(result["backupIdentity"], original["treeFingerprint"])
        backup = Path(result["backup"])
        preserved = MANAGER.validate_baseline_repair_old_tree(
            backup, old_fingerprint
        )
        self.assertEqual(preserved, original)
        active_manifest = json.loads(
            (self.active / "release-manifest.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            active_manifest["releaseProfile"], MANAGER.BASELINE_REPAIR_PROFILE
        )
        self.assertEqual(
            active_manifest["images"]["api"]["reference"],
            MANAGER.BASELINE_REPAIR_CURRENT_IMAGE,
        )
        self.assertFalse((self.active / "deployment-state").exists())
        with mock.patch.object(
            MANAGER, "BASELINE_REPAIR_OLD_FINGERPRINT", old_fingerprint
        ):
            restored = MANAGER.restore_baseline_repair(
                repaired_fingerprint=repair_fingerprint,
                backup_identity=result["backupIdentity"],
                run_id="abcdef0123456789",
                parent=self.parent,
                active=self.active,
                lock_path=self.lock,
            )
        self.assertEqual(restored["status"], "baseline-repair-restored")
        after = MANAGER.validate_baseline_repair_old_tree(
            self.active, old_fingerprint
        )
        self.assertEqual(after, original)
        self.assertEqual(
            json.loads((backup / "release-manifest.json").read_text())["releaseProfile"],
            MANAGER.BASELINE_REPAIR_PROFILE,
        )

    def test_baseline_repair_legacy_contract_matches_readonly_evidence(self):
        self.assertEqual(len(MANAGER.BASELINE_REPAIR_LEGACY_DIRECTORIES), 5)
        self.assertEqual(len(MANAGER.BASELINE_REPAIR_LEGACY_FILES), 18)
        self.assertEqual(len(MANAGER.BASELINE_REPAIR_COMPANION_PAIRS), 7)
        self.assertEqual(
            MANAGER.BASELINE_REPAIR_LEGACY_FILES[
                "deployment-state/evidence/render-diff.sanitized.json"
            ][1],
            "cc2d19a1202570033ce34d87ef3ac7fc9c340aed854d0f87afe79f5ed265a5f0",
        )
        self.assertEqual(
            MANAGER.BASELINE_REPAIR_LEGACY_FILES[
                "deployment-state/pointers.json"
            ][1],
            "670f2ab7d46ba5f3bdf2b87bbde46c8a2cd5dd50b45ce91ee0b3fa4c98850312",
        )

    def test_baseline_repair_rejects_legacy_path_metadata_and_link_drift(self):
        old_fingerprint, _, _ = self.prepare_baseline_repair()
        evidence = Path("deployment-state/evidence")

        missing = self.clone_legacy_tree("legacy-missing")
        (missing / evidence / "render-diff.sanitized.json").unlink()
        with self.assertRaisesRegex(MANAGER.ContractError, "incomplete"):
            MANAGER.validate_baseline_repair_old_tree(missing, old_fingerprint)

        extra = self.clone_legacy_tree("legacy-extra")
        extra_file = extra / evidence / "unexpected.sanitized.log"
        extra_file.write_bytes(b"unexpected\n")
        os.chown(extra_file, 0, 0)
        os.chmod(extra_file, 0o600)
        with self.assertRaisesRegex(MANAGER.ContractError, "unexpected path"):
            MANAGER.validate_baseline_repair_old_tree(extra, old_fingerprint)

        changed = self.clone_legacy_tree("legacy-content")
        (changed / evidence / "keep.sanitized.log").write_bytes(b"changed\n")
        with self.assertRaisesRegex(MANAGER.ContractError, "legacy content hash"):
            MANAGER.validate_baseline_repair_old_tree(changed, old_fingerprint)

        wrong_mode = self.clone_legacy_tree("legacy-mode")
        os.chmod(wrong_mode / evidence / "keep.sanitized.log", 0o640)
        with self.assertRaisesRegex(MANAGER.ContractError, "metadata mismatch"):
            MANAGER.validate_baseline_repair_old_tree(wrong_mode, old_fingerprint)

        wrong_owner = self.clone_legacy_tree("legacy-owner")
        os.chown(wrong_owner / evidence / "keep.sanitized.log", 1, 0)
        with self.assertRaisesRegex(MANAGER.ContractError, "metadata mismatch"):
            MANAGER.validate_baseline_repair_old_tree(wrong_owner, old_fingerprint)

        symlink = self.clone_legacy_tree("legacy-symlink")
        symlink_target = symlink / evidence / "render-diff.sanitized.json"
        symlink_target.unlink()
        symlink_target.symlink_to("final.sanitized.log")
        with self.assertRaisesRegex(MANAGER.ContractError, "unique regular file"):
            MANAGER.validate_baseline_repair_old_tree(symlink, old_fingerprint)

        hardlink = self.clone_legacy_tree("legacy-hardlink")
        hardlink_target = hardlink / evidence / "render-diff.sanitized.json"
        hardlink_target.unlink()
        os.link(hardlink / evidence / "final.sanitized.log", hardlink_target)
        with self.assertRaisesRegex(MANAGER.ContractError, "unique regular file"):
            MANAGER.validate_baseline_repair_old_tree(hardlink, old_fingerprint)

        extra_overlay = self.clone_legacy_tree("legacy-overlay-extra")
        added_overlay = extra_overlay / "deployment-state/overlays" / ("c" * 64)
        added_overlay.mkdir(mode=0o755)
        os.chown(added_overlay, 0, 0)
        with self.assertRaisesRegex(MANAGER.ContractError, "unexpected path"):
            MANAGER.validate_baseline_repair_old_tree(extra_overlay, old_fingerprint)

    def test_baseline_repair_validates_companion_semantics_beyond_file_hash(self):
        old_fingerprint, _, _ = self.prepare_baseline_repair()
        companion_relative = (
            "deployment-state/evidence/t-plus-0.sanitized.log.sha256"
        )

        cases = {
            "digest": "0" * 64 + "  t-plus-0.sanitized.log\n",
            "basename": "0" * 64 + "  keep.sanitized.log\n",
            "missing-lf": "0" * 64 + "  t-plus-0.sanitized.log",
            "extra-line": "0" * 64 + "  t-plus-0.sanitized.log\nextra\n",
        }
        for name, value in cases.items():
            with self.subTest(name=name):
                candidate = self.clone_legacy_tree(f"legacy-companion-{name}")
                companion = candidate.joinpath(*companion_relative.split("/"))
                content = value.encode("ascii")
                companion.write_bytes(content)
                expected = dict(MANAGER.BASELINE_REPAIR_LEGACY_FILES)
                expected[companion_relative] = ("0600", sha256(content))
                error = "digest mismatch" if name == "digest" else "format mismatch"
                if name == "basename":
                    error = "basename mismatch"
                with mock.patch.object(
                    MANAGER, "BASELINE_REPAIR_LEGACY_FILES", expected
                ):
                    with self.assertRaisesRegex(MANAGER.ContractError, error):
                        MANAGER.validate_baseline_repair_old_tree(
                            candidate, old_fingerprint
                        )

        non_ascii = self.clone_legacy_tree("legacy-companion-non-ascii")
        companion = non_ascii.joinpath(*companion_relative.split("/"))
        content = b"\xff\n"
        companion.write_bytes(content)
        expected = dict(MANAGER.BASELINE_REPAIR_LEGACY_FILES)
        expected[companion_relative] = ("0600", sha256(content))
        with mock.patch.object(MANAGER, "BASELINE_REPAIR_LEGACY_FILES", expected):
            with self.assertRaisesRegex(MANAGER.ContractError, "not ASCII"):
                MANAGER.validate_baseline_repair_old_tree(non_ascii, old_fingerprint)

    def test_baseline_restore_rejects_mutated_legacy_backup(self):
        old_fingerprint, repair_bundle, repair_fingerprint = (
            self.prepare_baseline_repair()
        )
        result = self.repair_baseline(
            old_fingerprint, repair_bundle, repair_fingerprint
        )
        backup = Path(result["backup"])
        (backup / "deployment-state/evidence/keep.sanitized.log").write_bytes(
            b"mutated\n"
        )
        with mock.patch.object(
            MANAGER, "BASELINE_REPAIR_OLD_FINGERPRINT", old_fingerprint
        ):
            with self.assertRaisesRegex(MANAGER.ContractError, "legacy content hash"):
                MANAGER.restore_baseline_repair(
                    repaired_fingerprint=repair_fingerprint,
                    backup_identity=result["backupIdentity"],
                    run_id="abcdef0123456789",
                    parent=self.parent,
                    active=self.active,
                    lock_path=self.lock,
                )

    def test_baseline_repair_rejects_preconditions_before_active_exchange(self):
        old_fingerprint, repair_bundle, repair_fingerprint = (
            self.prepare_baseline_repair()
        )
        active_identity = (os.lstat(self.active).st_dev, os.lstat(self.active).st_ino)
        with self.assertRaisesRegex(MANAGER.ContractError, "approved 09E baseline"):
            self.repair_baseline(
                old_fingerprint,
                repair_bundle,
                repair_fingerprint,
                expected_old_fingerprint="sha256:" + "0" * 64,
            )
        self.assertEqual(
            (os.lstat(self.active).st_dev, os.lstat(self.active).st_ino),
            active_identity,
        )
        payload = repair_bundle / "docs" / "payload.txt"
        payload.write_text("invalid\n", encoding="utf-8")
        with self.assertRaisesRegex(MANAGER.ContractError, "content hash mismatch"):
            self.repair_baseline(
                old_fingerprint, repair_bundle, repair_fingerprint
            )
        self.assertEqual(
            (os.lstat(self.active).st_dev, os.lstat(self.active).st_ino),
            active_identity,
        )

    def test_baseline_repair_rejects_lock_backup_device_and_unavailable_exchange(self):
        old_fingerprint, repair_bundle, repair_fingerprint = (
            self.prepare_baseline_repair()
        )
        with MANAGER._exclusive_lock(self.lock):
            with self.assertRaisesRegex(MANAGER.ContractError, "lock is already held"):
                self.repair_baseline(
                    old_fingerprint, repair_bundle, repair_fingerprint
                )
        backup = self.parent / (
            MANAGER.BASELINE_REPAIR_BACKUP_PREFIX + "abcdef0123456789"
        )
        backup.mkdir()
        with self.assertRaisesRegex(MANAGER.ContractError, "backup path already exists"):
            self.repair_baseline(
                old_fingerprint, repair_bundle, repair_fingerprint
            )
        backup.rmdir()
        wrong_device_target = self.parent / ".genesis-release-device-check"
        with self.assertRaisesRegex(MANAGER.ContractError, "different filesystem"):
            MANAGER.stage_bundle(
                repair_bundle,
                wrong_device_target,
                repair_fingerprint,
                MANAGER.BASELINE_REPAIR_CURRENT_IMAGE,
                "current",
                expected_device=os.lstat(self.parent).st_dev + 1,
            )
        shutil.rmtree(wrong_device_target)
        active_identity = (os.lstat(self.active).st_dev, os.lstat(self.active).st_ino)
        with mock.patch.object(
            MANAGER,
            "_rename_exchange",
            side_effect=MANAGER.AtomicPrimitiveUnavailable(
                "ATOMIC_PRIMITIVE_UNAVAILABLE"
            ),
        ):
            with self.assertRaisesRegex(
                MANAGER.AtomicPrimitiveUnavailable,
                "ATOMIC_PRIMITIVE_UNAVAILABLE",
            ):
                self.repair_baseline(
                    old_fingerprint, repair_bundle, repair_fingerprint
                )
        self.assertEqual(
            (os.lstat(self.active).st_dev, os.lstat(self.active).st_ino),
            active_identity,
        )

    def test_baseline_repair_post_exchange_failure_restores_exact_old_inode(self):
        old_fingerprint, repair_bundle, repair_fingerprint = (
            self.prepare_baseline_repair()
        )
        original = MANAGER.validate_baseline_repair_old_tree(
            self.active, old_fingerprint
        )

        def fail():
            raise RuntimeError("injected baseline repair validation failure")

        with self.assertRaisesRegex(MANAGER.ContractError, "exact old active restored"):
            self.repair_baseline(
                old_fingerprint,
                repair_bundle,
                repair_fingerprint,
                after_exchange=fail,
            )
        restored = MANAGER.validate_baseline_repair_old_tree(
            self.active, old_fingerprint
        )
        self.assertEqual(restored, original)
        backup = self.parent / (
            MANAGER.BASELINE_REPAIR_BACKUP_PREFIX + "abcdef0123456789"
        )
        self.assertEqual(
            json.loads((backup / "release-manifest.json").read_text())["releaseProfile"],
            MANAGER.BASELINE_REPAIR_PROFILE,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
