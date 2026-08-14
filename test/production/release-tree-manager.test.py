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


def build_bundle(root, image, payload, release_role):
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
    current_compose = (
        f"services:\n  migrate:\n    image: {CURRENT_IMAGE}\n"
        f"  api:\n    image: {CURRENT_IMAGE}\n"
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
                **(
                    {"relation": "previous-approved"}
                    if release_role == "rollback"
                    else {}
                ),
            }
        },
        "rollback": {"api": {"reference": ROLLBACK_IMAGE}},
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
    raw = (json.dumps(manifest, indent=2) + "\n").encode()
    manifest_path = root / "release-manifest.json"
    manifest_path.write_bytes(raw)
    os.chown(manifest_path, 0, 0)
    os.chmod(manifest_path, 0o644)
    return "sha256:" + sha256(raw)


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
