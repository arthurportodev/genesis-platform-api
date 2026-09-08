from __future__ import annotations

import contextlib
import email.message
import importlib.util
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import types
import unittest
import urllib.request
import urllib.response
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "docker/production/deploy-api-simple.py"
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("deploy_api_simple", MODULE_PATH)
assert SPEC and SPEC.loader
deploy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = deploy
SPEC.loader.exec_module(deploy)

APPLICATION_SOURCE_SHA = "a" * 40
OPERATIONAL_SOURCE_SHA = "b" * 40
PREVIOUS = f"{deploy.IMAGE_REPOSITORY}@sha256:{'1' * 64}"
CANDIDATE = f"{deploy.IMAGE_REPOSITORY}@sha256:{'2' * 64}"
PRODUCTION_MIGRATIONS = (
    "CreateMultiTenantCore1784400000000",
    "CreateAuthSessions1784486400000",
    "CreateOrganizationInvitations1785004800000",
    "DeliverInvitationAcceptance1785087600000",
    "ActivateNewInvitationUser1785174000000",
    "ManageMembershipOwnership1785260400000",
    "CreateLeadFoundation1785346800000",
    "ManageLeadCommercialPipeline1785433200000",
    "ManageLeadActivitiesFollowUp1785519600000",
    "AddLeadOperationalReadIndexes1785606000000",
    "ManageLeadCommercialCycleExpectedValue1788289200000",
)


def production_env_bytes(
    auth_values: dict[str, str] | None = None,
) -> bytes:
    values = {
        "DATABASE_NAME": "genesis_platform",
        "DATABASE_BOOTSTRAP_USER": "genesis_bootstrap",
        "DATABASE_MIGRATION_USER": "genesis_migration",
        "DATABASE_RUNTIME_ROLE": "genesis_runtime",
        "APP_NAME": "Genesis Platform API",
        "APP_VERSION": "0.1.0",
        "ACME_EMAIL": "ops@example.com",
        "TRUST_PROXY_HOPS": "1",
        "JWT_ACCESS_EXPIRES_IN": "15m",
        "REFRESH_TOKEN_EXPIRES_IN_DAYS": "30",
        "LEAD_IDEMPOTENCY_KEY_CURRENT_VERSION": "1",
        "API_CPUS": "0.75",
        "API_MEMORY_LIMIT": "1g",
        "API_PIDS_LIMIT": "128",
        "API_NODE_MAX_OLD_SPACE_MB": "640",
        "MIGRATE_CPUS": "0.75",
        "MIGRATE_MEMORY_LIMIT": "1g",
        "MIGRATE_PIDS_LIMIT": "128",
        "MIGRATE_NODE_MAX_OLD_SPACE_MB": "640",
        "POSTGRES_CPUS": "1.0",
        "POSTGRES_MEMORY_LIMIT": "2g",
        "POSTGRES_PIDS_LIMIT": "256",
        "TRAEFIK_CPUS": "0.50",
        "TRAEFIK_MEMORY_LIMIT": "256m",
        "TRAEFIK_PIDS_LIMIT": "128",
    }
    if auth_values is not None:
        values.update(auth_values)
    return "".join(f"{key}={values[key]}\n" for key in values).encode()


def chmod(path: Path, mode: int) -> None:
    path.chmod(mode)


class IntegrityFixture:
    files = ("one.txt", "nested/two.sh")

    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "deploy"
        self.config = Path(self.temporary.name) / "config"
        self.root.mkdir(mode=0o755)
        (self.root / "nested").mkdir(mode=0o755)
        self.config.mkdir(mode=0o755)
        (self.root / "one.txt").write_bytes(b"one\n")
        (self.root / "nested/two.sh").write_bytes(b"two\n")
        for relative in self.files:
            chmod(self.root / relative, 0o644)
        self.production_env = self.config / "production.env"
        self.production_env.write_bytes(production_env_bytes())
        chmod(self.production_env, 0o600)
        self.manifest = self.root / "operational-integrity.json"
        payload = deploy._operational_manifest_payload(
            self.root,
            self.production_env,
            OPERATIONAL_SOURCE_SHA,
            files=self.files,
        )
        self.manifest.write_text(json.dumps(payload) + "\n", encoding="utf-8")
        chmod(self.manifest, 0o600)
        self.paths = deploy.DeploymentPaths(
            deploy_root=self.root,
            production_env=self.production_env,
            pointer=self.config / "api-image.env",
            manifest=self.manifest,
            lock=Path(self.temporary.name) / "lock" / "deploy.lock",
            evidence_root=Path(self.temporary.name) / "evidence",
            registry_credentials=Path(self.temporary.name) / "registry.json",
            smoke_credentials=Path(self.temporary.name) / "smoke.json",
            release_evidence=Path(self.temporary.name) / "release.json",
            recovery_runner=Path(self.temporary.name) / "backup-runner.sh",
            recovery_env=Path(self.temporary.name) / "recovery.env",
            recovery_status=Path(self.temporary.name) / "backup-status.json",
        )

    def verify(self):
        return deploy.verify_operational_integrity(
            self.paths,
            OPERATIONAL_SOURCE_SHA,
            policy=deploy.MetadataPolicy(uid=None, gid=None),
            files=self.files,
        )

    def close(self):
        self.temporary.cleanup()


class OperationalInstallerFixture:
    files = ("one.txt", "nested/two.sh", "stable.txt")
    current_source_sha = "c" * 40
    run_id = "0123456789abcdef"

    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.parent = Path(self.temporary.name)
        chmod(self.parent, 0o700)
        self.source = self.parent / "source"
        self.deploy_root = self.parent / "deploy"
        self.config = self.parent / "config"
        self.lock_parent = self.parent / "run"
        for directory in (
            self.source,
            self.deploy_root,
            self.config,
            self.lock_parent,
        ):
            directory.mkdir(mode=0o700)
        for root in (self.source, self.deploy_root):
            (root / "nested").mkdir(mode=0o700)

        current = {
            "one.txt": b"old-one\n",
            "nested/two.sh": b"old-two\n",
            "stable.txt": b"stable\n",
        }
        target = {
            "one.txt": b"new-one\n",
            "nested/two.sh": b"new-two\n",
            "stable.txt": b"stable\n",
        }
        operator_path = "docker/production/deploy-api-simple.py"
        if operator_path in self.files:
            current[operator_path] = b"raise SystemExit('destination operator executed')\n"
            target[operator_path] = MODULE_PATH.read_bytes()
        for relative in self.files:
            (self.deploy_root / relative).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            (self.source / relative).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            (self.deploy_root / relative).write_bytes(current[relative])
            (self.source / relative).write_bytes(target[relative])
            chmod(self.deploy_root / relative, 0o644)
            chmod(self.source / relative, 0o644)

        self.production_env = self.config / "production.env"
        self.production_env.write_bytes(production_env_bytes())
        chmod(self.production_env, 0o600)
        self.manifest = self.deploy_root / "operational-integrity.json"
        current_manifest = deploy._operational_manifest_payload(
            self.deploy_root,
            self.production_env,
            self.current_source_sha,
            files=self.files,
        )
        self.manifest.write_bytes(deploy.operational_manifest_bytes(current_manifest))
        chmod(self.manifest, 0o600)
        self.paths = deploy.DeploymentPaths(
            deploy_root=self.deploy_root,
            production_env=self.production_env,
            pointer=self.config / "api-image.env",
            manifest=self.manifest,
            lock=self.lock_parent / "deploy.lock",
            evidence_root=self.parent / "evidence",
            registry_credentials=self.parent / "registry.json",
            smoke_credentials=self.parent / "smoke.json",
            release_evidence=self.parent / "release.json",
            recovery_runner=self.parent / "backup-runner.sh",
            recovery_env=self.parent / "recovery.env",
            recovery_status=self.parent / "backup-status.json",
        )
        self.policy = (
            deploy.MetadataPolicy(uid=None, gid=None)
            if os.name == "nt"
            else deploy.MetadataPolicy(uid=os.getuid(), gid=os.getgid())
        )
        self.runner = deploy.CommandRunner()
        self.runner.run(("git", "init", str(self.source)))
        self.runner.run(
            ("git", "-C", str(self.source), "config", "core.autocrlf", "false")
        )
        self.runner.run(("git", "-C", str(self.source), "add", "--", *self.files))
        self.runner.run(
            (
                "git",
                "-C",
                str(self.source),
                "-c",
                "user.name=Genesis Test",
                "-c",
                "user.email=genesis-test@example.invalid",
                "commit",
                "-m",
                "target operational bytes",
            )
        )
        self.target_source_sha = self.runner.run(
            ("git", "-C", str(self.source), "rev-parse", "HEAD")
        ).stdout.strip()
        self.runner.run(("git", "-C", str(self.source), "checkout", "--detach", "HEAD"))

    def plan(self, *, probe_lock=None):
        if probe_lock is None:
            probe_lock = deploy.fcntl is not None
        return deploy.build_operational_install_plan(
            self.source,
            self.paths,
            self.current_source_sha,
            self.target_source_sha,
            self.runner,
            policy=self.policy,
            files=self.files,
            probe_lock=probe_lock,
        )

    def authorization(self, plan=None):
        return deploy.operational_install_authorization(plan or self.plan(), self.run_id)

    def install(self, *, hook=None, rollback_hook=None, authorization=None):
        plan = self.plan(probe_lock=False)
        lock_context = contextlib.nullcontext()
        if deploy.fcntl is None:
            class PortableLock:
                def __init__(self, *_args, **_kwargs):
                    pass

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

            stack = contextlib.ExitStack()
            stack.enter_context(mock.patch.object(deploy, "DeploymentLock", PortableLock))
            stack.enter_context(mock.patch.object(deploy, "probe_deployment_lock"))
            lock_context = stack
        with lock_context:
            return deploy.install_operational_bytes(
                self.source,
                self.paths,
                run_id=self.run_id,
                current_source_sha=self.current_source_sha,
                target_source_sha=self.target_source_sha,
                authorization=authorization or self.authorization(plan),
                runner=self.runner,
                policy=self.policy,
                files=self.files,
                hook=hook,
                rollback_hook=rollback_hook,
            )

    def snapshot(self):
        result = {}
        for path in sorted(self.deploy_root.rglob("*")):
            if path.is_file():
                metadata = path.stat()
                result[path.relative_to(self.deploy_root).as_posix()] = (
                    path.read_bytes(),
                    metadata.st_mtime_ns,
                    metadata.st_ino,
                )
        return result

    def verify_current(self):
        return deploy.verify_operational_integrity(
            self.paths,
            self.current_source_sha,
            policy=self.policy,
            files=self.files,
        )

    def verify_target(self):
        return deploy.verify_operational_integrity(
            self.paths,
            self.target_source_sha,
            policy=self.policy,
            files=self.files,
        )

    def close(self):
        self.temporary.cleanup()


class ProductionEnvironmentContractTests(unittest.TestCase):
    def historical_values(self) -> dict[str, str]:
        return deploy.parse_env_bytes(production_env_bytes())

    def test_normalizes_historical_config_to_safe_auth_defaults(self):
        normalized = deploy.validate_production_values(self.historical_values())
        self.assertEqual(set(normalized), deploy.PRODUCTION_ENV_KEYS)
        self.assertEqual(normalized["AUTH_OTP_PUBLIC_FLOWS_ENABLED"], "false")
        self.assertEqual(normalized["AUTH_EMAIL_FROM"], "")

    def test_accepts_complete_disabled_and_enabled_auth_config(self):
        for auth_values in (
            {
                "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "false",
                "AUTH_EMAIL_FROM": "",
            },
            {
                "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "true",
                "AUTH_EMAIL_FROM": "auth@example.com",
            },
            {
                "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "true",
                "AUTH_EMAIL_FROM": "Genesis <auth@example.com>",
            },
        ):
            with self.subTest(auth_values=auth_values):
                parsed = deploy.parse_env_bytes(production_env_bytes(auth_values))
                self.assertEqual(deploy.validate_production_values(parsed), parsed)

    def test_rejects_partial_invalid_or_unsafe_auth_config(self):
        invalid_cases = (
            {"AUTH_OTP_PUBLIC_FLOWS_ENABLED": "false"},
            {"AUTH_EMAIL_FROM": "auth@example.com"},
            {
                "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "1",
                "AUTH_EMAIL_FROM": "auth@example.com",
            },
            {
                "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "true",
                "AUTH_EMAIL_FROM": "",
            },
            {
                "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "true",
                "AUTH_EMAIL_FROM": "not-an-email",
            },
            {
                "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "true",
                "AUTH_EMAIL_FROM": "auth@example.com\r\nBcc: attacker@example.com",
            },
            {
                "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "true",
                "AUTH_EMAIL_FROM": f"{'x' * 310}@example.com",
            },
        )
        for auth_values in invalid_cases:
            with self.subTest(auth_values=auth_values):
                values = {**self.historical_values(), **auth_values}
                with self.assertRaises(deploy.DeployStop):
                    deploy.validate_production_values(values)


class OperationalIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.fixture = IntegrityFixture()

    def tearDown(self):
        self.fixture.close()

    def test_accepts_exact_operational_bytes_and_config(self):
        self.assertEqual(set(self.fixture.verify()), deploy.PRODUCTION_ENV_KEYS)

    def test_rejects_changed_bytes(self):
        (self.fixture.root / "one.txt").write_bytes(b"changed\n")
        with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_FILE_HASH_DIVERGED"):
            self.fixture.verify()

    def test_rejects_missing_and_unexpected_files(self):
        (self.fixture.root / "one.txt").unlink()
        with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_FILE_SET_DIVERGED"):
            self.fixture.verify()
        self.fixture.close()
        self.fixture = IntegrityFixture()
        (self.fixture.root / "extra.txt").write_text("extra", encoding="utf-8")
        with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_FILE_SET_DIVERGED"):
            self.fixture.verify()

    def test_rejects_mode_and_hardlink(self):
        if os.name != "nt":
            chmod(self.fixture.root / "one.txt", 0o600)
            with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_FILE_METADATA_DIVERGED"):
                self.fixture.verify()
            chmod(self.fixture.root / "one.txt", 0o644)
        outside = Path(self.fixture.temporary.name) / "outside.txt"
        outside.write_text("one\n", encoding="utf-8")
        (self.fixture.root / "one.txt").unlink()
        os.link(outside, self.fixture.root / "one.txt")
        with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_FILE_METADATA_DIVERGED"):
            self.fixture.verify()

    def test_rejects_symlink_and_traversal(self):
        with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_PATH_TRAVERSAL"):
            deploy.normalized_relative_path("../escape")
        fake = types.SimpleNamespace(
            st_mode=stat.S_IFLNK | 0o777, st_nlink=1, st_uid=0, st_gid=0
        )
        with mock.patch.object(Path, "lstat", return_value=fake):
            with self.assertRaisesRegex(deploy.DeployStop, "UNSAFE_FILE_METADATA"):
                deploy.validate_regular_metadata(
                    Path("link"), policy=deploy.MetadataPolicy()
                )

    def test_rejects_owner_group_and_unsafe_parent(self):
        regular = types.SimpleNamespace(
            st_mode=stat.S_IFREG | 0o600, st_nlink=1, st_uid=1, st_gid=1
        )
        with mock.patch.object(Path, "lstat", return_value=regular):
            with self.assertRaisesRegex(deploy.DeployStop, "UNSAFE_FILE_METADATA"):
                deploy.validate_regular_metadata(
                    Path("file"), policy=deploy.MetadataPolicy()
                )
        safe_directory = types.SimpleNamespace(
            st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0
        )
        with mock.patch.object(Path, "lstat", return_value=safe_directory), mock.patch.object(
            Path, "is_symlink", return_value=False
        ):
            deploy.validate_safe_directory(
                Path("parent"), policy=deploy.MetadataPolicy()
            )
        unsafe_directory = types.SimpleNamespace(
            st_mode=stat.S_IFDIR | 0o1777, st_uid=0, st_gid=0
        )
        with mock.patch.object(Path, "lstat", return_value=unsafe_directory), mock.patch.object(
            Path, "is_symlink", return_value=False
        ):
            with self.assertRaisesRegex(deploy.DeployStop, "UNSAFE_PARENT_DIRECTORY"):
                deploy.validate_safe_directory(
                    Path("parent"), policy=deploy.MetadataPolicy()
                )

    def test_rejects_invalid_manifest_source_and_production_config(self):
        self.fixture.manifest.write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(deploy.DeployStop, "INVALID_OPERATIONAL_MANIFEST"):
            self.fixture.verify()
        self.fixture.close()
        self.fixture = IntegrityFixture()
        with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_SOURCE_SHA_DIVERGED"):
            deploy.verify_operational_integrity(
                self.fixture.paths,
                "c" * 40,
                policy=deploy.MetadataPolicy(uid=None, gid=None),
                files=self.fixture.files,
            )
        self.fixture.production_env.write_bytes(production_env_bytes() + b"APP_NAME=duplicate\n")
        with self.assertRaisesRegex(deploy.DeployStop, "PRODUCTION_ENV_HASH_DIVERGED"):
            self.fixture.verify()

    @unittest.skipUnless(shutil.which("git"), "Git snapshot proof")
    def test_manifest_requires_clean_approved_git_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repository"
            root.mkdir()
            (root / "nested").mkdir()
            (root / "one.txt").write_bytes(b"one\n")
            (root / "nested/two.sh").write_bytes(b"two\n")
            production_env = Path(temporary) / "production.env"
            production_env.write_bytes(production_env_bytes())
            chmod(production_env, 0o600)
            runner = deploy.CommandRunner()
            runner.run(("git", "init", str(root)))
            runner.run(("git", "-C", str(root), "config", "core.autocrlf", "false"))
            runner.run(("git", "-C", str(root), "add", "one.txt", "nested/two.sh"))
            runner.run(
                (
                    "git",
                    "-C",
                    str(root),
                    "-c",
                    "user.name=Genesis Test",
                    "-c",
                    "user.email=genesis-test@example.invalid",
                    "commit",
                    "-m",
                    "fixture",
                )
            )
            operational_sha = runner.run(
                ("git", "-C", str(root), "rev-parse", "HEAD")
            ).stdout.strip()
            manifest = deploy.build_operational_manifest(
                root,
                production_env,
                operational_sha,
                runner,
                files=("one.txt", "nested/two.sh"),
            )
            self.assertEqual(manifest["operationalSourceSha"], operational_sha)
            (root / "one.txt").write_bytes(b"dirty\n")
            with self.assertRaisesRegex(
                deploy.DeployStop,
                "OPERATIONAL_SOURCE_DIRTY",
            ):
                deploy.build_operational_manifest(
                    root,
                    production_env,
                    operational_sha,
                    runner,
                    files=("one.txt", "nested/two.sh"),
                )


@unittest.skipUnless(shutil.which("git"), "Git snapshot proof")
class OperationalInstallerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = OperationalInstallerFixture()

    def tearDown(self):
        self.fixture.close()

    def test_prepare_is_deterministic_read_only_and_binds_exact_delta(self):
        before = self.fixture.snapshot()
        first = self.fixture.plan()
        second = self.fixture.plan()
        self.assertEqual(first, second)
        self.assertEqual(before, self.fixture.snapshot())
        if deploy.fcntl is not None:
            self.assertFalse(self.fixture.paths.lock.exists())
        self.assertEqual(
            [entry.path for entry in first.changed],
            ["one.txt", "nested/two.sh"],
        )
        self.assertEqual([entry.path for entry in first.unchanged], ["stable.txt"])
        self.assertTrue(first.same_filesystem_parent)
        rendered = first.as_dict()
        self.assertEqual(rendered["mutationCount"], 0)
        self.assertTrue(rendered["installRequired"])
        authorization = self.fixture.authorization(first)
        self.assertEqual(
            authorization,
            deploy.operational_install_authorization(second, self.fixture.run_id),
        )
        for entry in first.changed:
            self.assertIn(f"{entry.path}={entry.sha256}@{entry.mode}", authorization)

    def test_auth_v2_02_historical_operational_delta_is_the_expected_three_paths(self):
        runner = deploy.CommandRunner()
        historical = "c3103e495b3ca2525b18c27445412bb6f90f3bd2"
        target = "6448cd27bc33b58dfcbf5e6014466b6168b25cef"
        for commit in (historical, target):
            available = runner.run(
                ("git", "-C", str(ROOT), "cat-file", "-e", f"{commit}^{{commit}}"),
                check=False,
            )
            if available.returncode != 0:
                self.skipTest("Historical full Git repository unavailable")
        changed = runner.run(
            (
                "git",
                "-C",
                str(ROOT),
                "diff",
                "--name-only",
                historical,
                target,
                "--",
                *deploy.OPERATIONAL_FILES,
            )
        ).stdout.splitlines()
        self.assertEqual(
            changed,
            [
                "compose.production.yml",
                "docker/production/api-entrypoint.sh",
                "docker/production/deploy-api-simple.py",
            ],
        )

    def test_rejects_attached_dirty_missing_mode_and_hardlinked_sources(self):
        cases = []

        def attached(fixture):
            fixture.runner.run(
                (
                    "git",
                    "-C",
                    str(fixture.source),
                    "checkout",
                    "-B",
                    "fixture-branch",
                    fixture.target_source_sha,
                )
            )

        cases.append(("attached", attached, "OPERATIONAL_SOURCE_NOT_DETACHED"))

        def wrong_checkout(fixture):
            (fixture.source / "stable.txt").write_bytes(b"different commit\n")
            fixture.runner.run(
                ("git", "-C", str(fixture.source), "add", "--", "stable.txt")
            )
            fixture.runner.run(
                (
                    "git",
                    "-C",
                    str(fixture.source),
                    "-c",
                    "user.name=Genesis Test",
                    "-c",
                    "user.email=genesis-test@example.invalid",
                    "commit",
                    "-m",
                    "different checkout",
                )
            )

        cases.append(("wrong-checkout", wrong_checkout, "OPERATIONAL_SOURCE_NOT_APPROVED"))
        cases.append(
            (
                "dirty-untracked",
                lambda fixture: (fixture.source / "untracked.txt").write_text("dirty"),
                "OPERATIONAL_SOURCE_DIRTY",
            )
        )
        cases.append(
            (
                "missing",
                lambda fixture: (fixture.source / "one.txt").unlink(),
                "OPERATIONAL_SOURCE_DIRTY",
            )
        )
        if os.name != "nt":
            cases.append(
                (
                    "mode",
                    lambda fixture: chmod(fixture.source / "one.txt", 0o600),
                    "OPERATIONAL_SOURCE_METADATA_DIVERGED",
                )
            )
            def symlink(fixture):
                outside = fixture.parent / "symlink-target.txt"
                outside.write_bytes(b"new-one\n")
                (fixture.source / "one.txt").unlink()
                os.symlink(outside, fixture.source / "one.txt")

            cases.append(("symlink", symlink, "OPERATIONAL_SOURCE_DIRTY"))

        def hardlink(fixture):
            outside = fixture.parent / "same-bytes.txt"
            outside.write_bytes((fixture.source / "one.txt").read_bytes())
            (fixture.source / "one.txt").unlink()
            os.link(outside, fixture.source / "one.txt")

        cases.append(("hardlink", hardlink, "OPERATIONAL_SOURCE_METADATA_DIVERGED"))
        for name, mutate, reason in cases:
            with self.subTest(name=name):
                fixture = OperationalInstallerFixture()
                try:
                    mutate(fixture)
                    with self.assertRaisesRegex(deploy.DeployStop, reason):
                        fixture.plan()
                finally:
                    fixture.close()

    def test_tracked_non_allowlisted_source_path_is_never_installed(self):
        extra = self.fixture.source / "unrelated.txt"
        extra.write_bytes(b"not operational\n")
        self.fixture.runner.run(
            ("git", "-C", str(self.fixture.source), "add", "--", "unrelated.txt")
        )
        self.fixture.runner.run(
            (
                "git",
                "-C",
                str(self.fixture.source),
                "-c",
                "user.name=Genesis Test",
                "-c",
                "user.email=genesis-test@example.invalid",
                "commit",
                "-m",
                "tracked non-operational file",
            )
        )
        self.fixture.target_source_sha = self.fixture.runner.run(
            ("git", "-C", str(self.fixture.source), "rev-parse", "HEAD")
        ).stdout.strip()
        result = self.fixture.install()
        self.assertEqual(result["result"], "INSTALLED")
        self.assertFalse((self.fixture.deploy_root / "unrelated.txt").exists())
        self.fixture.verify_target()

    def test_install_replaces_only_changed_files_and_manifest_last(self):
        before = self.fixture.snapshot()
        events = []

        def record(stage, path):
            events.append((stage, path.relative_to(self.fixture.parent).as_posix()))

        result = self.fixture.install(hook=record)
        self.assertEqual(result["result"], "INSTALLED")
        self.assertEqual(result["mutationCount"], 3)
        self.fixture.verify_target()
        after = self.fixture.snapshot()
        self.assertEqual(before["stable.txt"], after["stable.txt"])
        self.assertNotEqual(before["one.txt"][0], after["one.txt"][0])
        install_replaces = [
            index
            for index, event in enumerate(events)
            if event[0] == "install:after_replace"
        ]
        manifest_replace = next(
            index for index, event in enumerate(events) if event[0] == "manifest:after_replace"
        )
        self.assertEqual(len(install_replaces), 2)
        self.assertLess(max(install_replaces), manifest_replace)
        if os.name != "nt":
            for relative in (*self.fixture.files, "operational-integrity.json"):
                metadata = (self.fixture.deploy_root / relative).stat()
                self.assertEqual(
                    (metadata.st_uid, metadata.st_gid),
                    (os.getuid(), os.getgid()),
                )
        self.assertFalse((self.fixture.parent / f".operational-install-{self.fixture.run_id}").exists())
        self.assertFalse((self.fixture.parent / f".operational-backup-{self.fixture.run_id}").exists())

    def test_wrong_authorization_or_orphan_state_stops_before_mutation(self):
        before = self.fixture.snapshot()
        with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_INSTALL_NOT_AUTHORIZED"):
            self.fixture.install(authorization="wrong")
        self.assertEqual(before, self.fixture.snapshot())
        orphan = self.fixture.parent / ".operational-backup-fedcba9876543210"
        orphan.mkdir(mode=0o700)
        with self.assertRaisesRegex(deploy.DeployStop, "ORPHAN_OPERATIONAL_INSTALL_STATE"):
            self.fixture.plan()
        self.assertEqual(before, self.fixture.snapshot())

    def test_filesystem_divergence_stops_before_mutation(self):
        before = self.fixture.snapshot()
        with mock.patch.object(
            deploy,
            "prove_same_filesystem",
            side_effect=deploy.DeployStop("OPERATIONAL_FILESYSTEM_DIVERGED"),
        ):
            with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_FILESYSTEM_DIVERGED"):
                self.fixture.plan()
        self.assertEqual(before, self.fixture.snapshot())

    @unittest.skipIf(os.name == "nt", "POSIX mode semantics required")
    def test_mode_only_delta_is_not_rewritten_as_a_changed_file(self):
        stable = self.fixture.deploy_root / "stable.txt"
        chmod(stable, 0o755)
        current_manifest = deploy._operational_manifest_payload(
            self.fixture.deploy_root,
            self.fixture.production_env,
            self.fixture.current_source_sha,
            files=self.fixture.files,
        )
        self.fixture.manifest.write_bytes(
            deploy.operational_manifest_bytes(current_manifest)
        )
        chmod(self.fixture.manifest, 0o600)
        with self.assertRaisesRegex(
            deploy.DeployStop,
            "OPERATIONAL_MODE_ONLY_CHANGE_UNSUPPORTED",
        ):
            self.fixture.plan()

    def test_first_middle_and_manifest_faults_restore_exact_old_generation(self):
        scenarios = (
            ("first", "install:before_write", "one.txt"),
            ("middle", "install:after_replace", "one.txt"),
            ("before-manifest", "before_manifest_install", "operational-integrity.json"),
            ("manifest", "manifest:after_replace", "operational-integrity.json"),
        )
        for name, fault_stage, filename in scenarios:
            with self.subTest(name=name):
                fixture = OperationalInstallerFixture()
                try:
                    before = fixture.snapshot()

                    def fail(stage, path):
                        if stage == fault_stage and path.name == filename:
                            raise RuntimeError(name)

                    result = fixture.install(hook=fail)
                    self.assertEqual(result["result"], "INSTALL_FAILED_ROLLED_BACK")
                    self.assertEqual(
                        result["failureReasonCode"],
                        "UNEXPECTED_OPERATIONAL_INSTALL_FAILURE",
                    )
                    fixture.verify_current()
                    after = fixture.snapshot()
                    self.assertEqual(
                        {path: data[0] for path, data in before.items()},
                        {path: data[0] for path, data in after.items()},
                    )
                finally:
                    fixture.close()

    def test_rollback_failure_leaves_fail_closed_manifest_and_evidence(self):
        def fail_install(stage, path):
            if stage == "install:after_replace" and path.name == "one.txt":
                raise RuntimeError("install")

        def fail_rollback(stage, path):
            if stage == "rollback:before_write" and path.name == "one.txt":
                raise RuntimeError("rollback")

        result = self.fixture.install(hook=fail_install, rollback_hook=fail_rollback)
        self.assertEqual(result["result"], "INSTALL_FAILED_FAIL_CLOSED")
        self.assertEqual(
            self.fixture.manifest.read_bytes(),
            deploy._fail_closed_manifest_bytes(),
        )
        with self.assertRaises(deploy.DeployStop):
            self.fixture.verify_current()
        self.assertTrue((self.fixture.parent / f".operational-install-{self.fixture.run_id}").exists())
        self.assertTrue((self.fixture.parent / f".operational-backup-{self.fixture.run_id}").exists())

    def test_crash_generations_are_invalid_until_manifest_switch(self):
        plan = self.fixture.plan()
        for entry in plan.changed[:1]:
            shutil.copyfile(self.fixture.source / entry.path, self.fixture.deploy_root / entry.path)
            chmod(self.fixture.deploy_root / entry.path, int(entry.mode, 8))
        with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_FILE_HASH_DIVERGED"):
            self.fixture.verify_current()
        for entry in plan.changed[1:]:
            shutil.copyfile(self.fixture.source / entry.path, self.fixture.deploy_root / entry.path)
            chmod(self.fixture.deploy_root / entry.path, int(entry.mode, 8))
        with self.assertRaisesRegex(deploy.DeployStop, "OPERATIONAL_FILE_HASH_DIVERGED"):
            self.fixture.verify_current()
        self.fixture.manifest.write_bytes(deploy.operational_manifest_bytes(plan.target_manifest))
        chmod(self.fixture.manifest, 0o600)
        self.fixture.verify_target()
        self.fixture.manifest.write_bytes(deploy._fail_closed_manifest_bytes())
        chmod(self.fixture.manifest, 0o600)
        with self.assertRaises(deploy.DeployStop):
            self.fixture.verify_target()

    def test_target_is_idempotent_with_zero_writes(self):
        first = self.fixture.install()
        self.assertEqual(first["result"], "INSTALLED")
        before = self.fixture.snapshot()
        plan = deploy.build_operational_install_plan(
            self.fixture.source,
            self.fixture.paths,
            self.fixture.target_source_sha,
            self.fixture.target_source_sha,
            self.fixture.runner,
            policy=self.fixture.policy,
            files=self.fixture.files,
            probe_lock=deploy.fcntl is not None,
        )
        if deploy.fcntl is None:
            class PortableLock:
                def __init__(self, *_args, **_kwargs):
                    pass

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

            stack = contextlib.ExitStack()
            stack.enter_context(mock.patch.object(deploy, "DeploymentLock", PortableLock))
            stack.enter_context(mock.patch.object(deploy, "probe_deployment_lock"))
            lock_context = stack
        else:
            lock_context = contextlib.nullcontext()
        with lock_context:
            result = deploy.install_operational_bytes(
                self.fixture.source,
                self.fixture.paths,
                run_id=self.fixture.run_id,
                current_source_sha=self.fixture.target_source_sha,
                target_source_sha=self.fixture.target_source_sha,
                authorization=deploy.operational_install_authorization(plan, self.fixture.run_id),
                runner=self.fixture.runner,
                policy=self.fixture.policy,
                files=self.fixture.files,
            )
        self.assertEqual(result["result"], "ALREADY_INSTALLED")
        self.assertEqual(result["mutationCount"], 0)
        self.assertEqual(before, self.fixture.snapshot())

    def test_identical_file_bytes_still_switch_target_manifest_identity(self):
        for relative in self.fixture.files:
            shutil.copyfile(
                self.fixture.source / relative,
                self.fixture.deploy_root / relative,
            )
            chmod(self.fixture.deploy_root / relative, 0o644)
        current_manifest = deploy._operational_manifest_payload(
            self.fixture.deploy_root,
            self.fixture.production_env,
            self.fixture.current_source_sha,
            files=self.fixture.files,
        )
        self.fixture.manifest.write_bytes(
            deploy.operational_manifest_bytes(current_manifest)
        )
        chmod(self.fixture.manifest, 0o600)
        plan = self.fixture.plan()
        self.assertEqual(plan.changed, ())
        self.assertTrue(plan.manifest_change)
        self.assertTrue(plan.install_required)
        result = self.fixture.install()
        self.assertEqual(result["result"], "INSTALLED")
        self.assertEqual(result["mutationCount"], 1)
        self.fixture.verify_target()

    @unittest.skipUnless(deploy.fcntl is not None, "Real flock required")
    def test_lock_contention_cleans_staging_without_destination_mutation(self):
        before = self.fixture.snapshot()
        with deploy.DeploymentLock(self.fixture.paths.lock, self.fixture.policy):
            result = self.fixture.install()
        self.assertEqual(result["result"], "INSTALL_FAILED_ROLLED_BACK")
        self.assertEqual(result["failureReasonCode"], "DEPLOYMENT_LOCK_HELD")
        self.assertEqual(before, self.fixture.snapshot())

    def test_parser_exposes_only_explicit_operational_identity_arguments(self):
        parser = deploy.build_parser()
        prepared = parser.parse_args(
            [
                "prepare-operational",
                "--source-root",
                str(self.fixture.source),
                "--current-operational-source-sha",
                self.fixture.current_source_sha,
                "--operational-source-sha",
                self.fixture.target_source_sha,
            ]
        )
        self.assertEqual(prepared.command, "prepare-operational")
        installed = parser.parse_args(
            [
                "install-operational",
                "--source-root",
                str(self.fixture.source),
                "--current-operational-source-sha",
                self.fixture.current_source_sha,
                "--operational-source-sha",
                self.fixture.target_source_sha,
                "--run-id",
                self.fixture.run_id,
                "--authorization",
                self.fixture.authorization(),
            ]
        )
        self.assertEqual(installed.command, "install-operational")

    def test_operator_self_installs_from_separate_clean_checkout(self):
        class SelfInstallFixture(OperationalInstallerFixture):
            files = (
                *OperationalInstallerFixture.files,
                "docker/production/deploy-api-simple.py",
            )

        fixture = SelfInstallFixture()
        try:
            operator = fixture.source / "docker/production/deploy-api-simple.py"
            spec = importlib.util.spec_from_file_location("self_install_operator", operator)
            self.assertIsNotNone(spec)
            self.assertIsNotNone(spec.loader)
            loaded = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = loaded
            spec.loader.exec_module(loaded)
            with mock.patch.object(loaded.sys, "argv", [str(operator.resolve())]):
                loaded.verify_operational_operator_invocation(fixture.source)
            with mock.patch.object(
                loaded.sys,
                "argv",
                ["docker/production/deploy-api-simple.py"],
            ):
                with self.assertRaisesRegex(
                    loaded.DeployStop,
                    "OPERATIONAL_OPERATOR_PATH_NOT_ABSOLUTE",
                ):
                    loaded.verify_operational_operator_invocation(fixture.source)
            runner = loaded.CommandRunner()
            policy = loaded.MetadataPolicy(uid=None, gid=None)
            plan = loaded.build_operational_install_plan(
                fixture.source,
                fixture.paths,
                fixture.current_source_sha,
                fixture.target_source_sha,
                runner,
                policy=policy,
                files=fixture.files,
                probe_lock=loaded.fcntl is not None,
            )
            authorization = loaded.operational_install_authorization(plan, fixture.run_id)
            if loaded.fcntl is None:
                class PortableLock:
                    def __init__(self, *_args, **_kwargs):
                        pass

                    def __enter__(self):
                        return self

                    def __exit__(self, *_args):
                        return False

                lock_context = mock.patch.object(loaded, "DeploymentLock", PortableLock)
            else:
                lock_context = contextlib.nullcontext()
            with lock_context:
                result = loaded.install_operational_bytes(
                    fixture.source,
                    fixture.paths,
                    run_id=fixture.run_id,
                    current_source_sha=fixture.current_source_sha,
                    target_source_sha=fixture.target_source_sha,
                    authorization=authorization,
                    runner=runner,
                    policy=policy,
                    files=fixture.files,
                )
            self.assertEqual(result["result"], "INSTALLED")
            self.assertEqual(
                (fixture.deploy_root / "docker/production/deploy-api-simple.py").read_bytes(),
                operator.read_bytes(),
            )
        finally:
            fixture.close()


class PointerAndEnvironmentTests(unittest.TestCase):
    def test_pointer_format_is_exact(self):
        self.assertEqual(deploy.pointer_bytes(CANDIDATE), f"API_IMAGE={CANDIDATE}\n".encode())
        for invalid in ("latest", CANDIDATE.upper(), f"{CANDIDATE}\n"):
            with self.assertRaises(deploy.DeployStop):
                deploy.pointer_bytes(invalid)

    def test_atomic_pointer_faults_always_leave_one_valid_generation(self):
        stages = (
            "before_write",
            "after_write",
            "before_fsync_file",
            "after_fsync_file",
            "before_replace",
            "after_replace",
            "before_fsync_directory",
            "after_fsync_directory",
        )
        for stage in stages:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as temporary:
                parent = Path(temporary)
                chmod(parent, 0o700)
                pointer = parent / "api-image.env"
                pointer.write_bytes(deploy.pointer_bytes(PREVIOUS))
                chmod(pointer, 0o600)

                def fail(current, _path):
                    if current == stage:
                        raise RuntimeError(stage)

                with self.assertRaisesRegex(RuntimeError, stage):
                    deploy.write_pointer(
                        pointer, CANDIDATE, uid=None, gid=None, hook=fail
                    )
                self.assertIn(pointer.read_bytes(), {deploy.pointer_bytes(PREVIOUS), deploy.pointer_bytes(CANDIDATE)})
                self.assertEqual(list(parent.glob(".api-image.env.*")), [])

    def test_pointer_runtime_divergence_stops(self):
        with self.assertRaisesRegex(deploy.DeployStop, "POINTER_RUNTIME_DIVERGENCE"):
            deploy.validate_pointer_runtime(PREVIOUS, CANDIDATE)

    def test_child_environment_is_scrubbed_without_mutating_parent(self):
        parent = {
            "API_IMAGE": PREVIOUS,
            "DATABASE_NAME": "hostile",
            "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "true",
            "AUTH_EMAIL_FROM": "attacker@example.com",
            "COMPOSE_FILE": "hostile.yml",
            "DOCKER_HOST": "tcp://hostile",
            "UNRELATED": "kept",
        }
        original = dict(parent)
        child = deploy.sanitized_child_environment(
            parent, deploy.PRODUCTION_ENV_KEYS, api_image=CANDIDATE
        )
        self.assertEqual(parent, original)
        self.assertEqual(child, {"UNRELATED": "kept", "API_IMAGE": CANDIDATE})


class CommandTimeoutTests(unittest.TestCase):
    def test_subprocess_timeout_is_fail_closed_and_explicit(self):
        with mock.patch.object(
            deploy.subprocess,
            "run",
            side_effect=deploy.subprocess.TimeoutExpired(["blocked"], 0.01),
        ) as run:
            with self.assertRaisesRegex(deploy.DeployStop, "SUBPROCESS_TIMEOUT"):
                deploy.CommandRunner().run(("blocked",), timeout_seconds=0.01)
        self.assertEqual(run.call_args.kwargs["timeout"], 0.01)


def rendered(
    image: str,
    auth_values: dict[str, str] | None = None,
) -> dict:
    auth_values = auth_values or {
        "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "false",
        "AUTH_EMAIL_FROM": "",
    }
    return {
        "name": "genesis",
        "services": {
            "api": {
                "image": image,
                "networks": {"database": {}, "edge": {}},
                "environment": auth_values,
            },
            "migrate": {"image": image, "networks": {"database": {}}},
            "postgres": {"image": "postgres@sha256:" + "3" * 64, "networks": {"database": {}}},
            "traefik": {"image": "traefik@sha256:" + "4" * 64, "networks": {"edge": {}}},
        },
        "volumes": {"postgres_data": {"external": True, "name": "genesis-postgres-data"}},
    }


class RecordingRunner(deploy.CommandRunner):
    def __init__(self, output: str = ""):
        self.output = output
        self.calls = []

    def run(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        return deploy.CommandResult(0, self.output, "")


class ComposeTests(unittest.TestCase):
    def paths(self, root: Path):
        return deploy.DeploymentPaths(
            deploy_root=root,
            production_env=root / "config/production.env",
            pointer=root / "config/api-image.env",
            manifest=root / "operational-integrity.json",
        )

    def test_canonical_argv_and_override_only_for_candidate_migrations(self):
        root = Path("C:/fixture/deploy").absolute()
        runner = RecordingRunner(json.dumps(rendered(PREVIOUS)))
        production_values = deploy.validate_production_values(
            deploy.parse_env_bytes(production_env_bytes())
        )
        compose = deploy.ComposeClient(
            runner,
            self.paths(root),
            production_values,
            {
                "API_IMAGE": PREVIOUS,
                "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "true",
                "AUTH_EMAIL_FROM": "attacker@example.com",
                "COMPOSE_FILE": "hostile",
                "SAFE": "yes",
            },
        )
        compose.render(PREVIOUS)
        argv, options = runner.calls[0]
        self.assertEqual(argv[:8], ["docker", "compose", "-p", "genesis", "--project-directory", str(root), "--env-file", str(root / "config/production.env")])
        self.assertIn(str(root / "config/api-image.env"), argv)
        self.assertEqual(
            argv[-7:],
            [
                "-f",
                str(root / "compose.production.functional.yml"),
                "-f",
                str(root / "compose.traefik-public-full.yml"),
                "config",
                "--format",
                "json",
            ],
        )
        self.assertNotIn("API_IMAGE", options["env"])
        self.assertEqual(options["env"]["SAFE"], "yes")
        self.assertNotIn("COMPOSE_FILE", options["env"])
        self.assertNotIn("AUTH_OTP_PUBLIC_FLOWS_ENABLED", options["env"])
        self.assertNotIn("AUTH_EMAIL_FROM", options["env"])
        runner.output = "[X] 1 Existing\n"
        compose.migration_inventory(CANDIDATE)
        self.assertEqual(runner.calls[1][1]["env"]["API_IMAGE"], CANDIDATE)
        runner.output = ""
        compose.recreate_api()
        self.assertNotIn("API_IMAGE", runner.calls[2][1]["env"])
        self.assertEqual(
            runner.calls[2][1]["timeout_seconds"],
            deploy.COMPOSE_MUTATION_TIMEOUT_SECONDS,
        )

    def test_rendered_previous_and_candidate_invariants(self):
        deploy.validate_rendered_compose(rendered(PREVIOUS), PREVIOUS)
        deploy.validate_rendered_compose(rendered(CANDIDATE), CANDIDATE)
        enabled = deploy.validate_production_values(
            deploy.parse_env_bytes(
                production_env_bytes(
                    {
                        "AUTH_OTP_PUBLIC_FLOWS_ENABLED": "true",
                        "AUTH_EMAIL_FROM": "Genesis <auth@example.com>",
                    }
                )
            )
        )
        deploy.validate_rendered_compose(
            rendered(CANDIDATE, enabled),
            CANDIDATE,
            expected_production_values=enabled,
        )
        divergent = rendered(CANDIDATE)
        with self.assertRaisesRegex(deploy.DeployStop, "COMPOSE_AUTH_CONFIG_DIVERGED"):
            deploy.validate_rendered_compose(
                divergent,
                CANDIDATE,
                expected_production_values=enabled,
            )
        for mutation, reason in (
            (lambda value: value["services"]["api"].update(ports=["3000:3000"]), "COMPOSE_PUBLIC_PORT_DIVERGED"),
            (lambda value: value["services"]["postgres"].update(ports=["5432:5432"]), "COMPOSE_PUBLIC_PORT_DIVERGED"),
            (lambda value: value["volumes"]["postgres_data"].update(name="other"), "COMPOSE_VOLUME_DIVERGED"),
        ):
            value = rendered(CANDIDATE)
            mutation(value)
            with self.assertRaisesRegex(deploy.DeployStop, reason):
                deploy.validate_rendered_compose(value, CANDIDATE)


class ImageRunner(deploy.CommandRunner):
    def __init__(self, metadata=None, local=True, pull_status=0):
        self.metadata = metadata
        self.local = local
        self.pull_status = pull_status
        self.calls = []

    def run(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        if list(argv[:3]) == ["docker", "image", "inspect"]:
            return deploy.CommandResult(0, json.dumps([self.metadata]), "") if self.local else deploy.CommandResult(1, "", "missing")
        if list(argv[:2]) == ["docker", "login"]:
            return deploy.CommandResult(0, "", "")
        if list(argv[:2]) == ["docker", "pull"]:
            if self.pull_status == 0:
                self.local = True
            return deploy.CommandResult(self.pull_status, "", "synthetic-password")
        raise AssertionError(argv)


def image_metadata(
    image=CANDIDATE,
    revision=APPLICATION_SOURCE_SHA,
    os_name="linux",
    architecture="amd64",
):
    return {
        "RepoDigests": [image],
        "Os": os_name,
        "Architecture": architecture,
        "Config": {"Labels": {"org.opencontainers.image.revision": revision}},
    }


class ImageTests(unittest.TestCase):
    def credentials(self, root: Path):
        path = root / "registry.json"
        path.write_text(json.dumps({"username": "fixture", "password": "do-not-log"}), encoding="utf-8")
        chmod(path, 0o600)
        return path

    def test_previous_local_and_absent_pull(self):
        with tempfile.TemporaryDirectory() as temporary:
            credentials = self.credentials(Path(temporary))
            local = ImageRunner(image_metadata(PREVIOUS))
            deploy.prove_image(local, PREVIOUS, credentials_path=credentials, policy=deploy.MetadataPolicy(uid=None, gid=None))
            self.assertFalse(any(call[0][1] == "pull" for call in local.calls))
            absent = ImageRunner(image_metadata(PREVIOUS), local=False)
            deploy.prove_image(absent, PREVIOUS, credentials_path=credentials, policy=deploy.MetadataPolicy(uid=None, gid=None))
            self.assertTrue(any(call[0][1] == "pull" for call in absent.calls))

    def test_pull_failure_is_redacted(self):
        with tempfile.TemporaryDirectory() as temporary:
            credentials = self.credentials(Path(temporary))
            runner = ImageRunner(image_metadata(PREVIOUS), local=False, pull_status=1)
            with self.assertRaisesRegex(deploy.DeployStop, "PREVIOUS_IMAGE_UNAVAILABLE") as caught:
                deploy.prove_image(runner, PREVIOUS, credentials_path=credentials, policy=deploy.MetadataPolicy(uid=None, gid=None))
            self.assertNotIn("do-not-log", str(caught.exception))
            self.assertNotIn("synthetic-password", str(caught.exception))

    def test_rejects_wrong_digest_platform_and_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            credentials = self.credentials(Path(temporary))
            for metadata, reason in (
                (image_metadata(PREVIOUS), "IMAGE_REPODIGEST_DIVERGED"),
                (image_metadata(architecture="arm64"), "IMAGE_PLATFORM_DIVERGED"),
                (image_metadata(revision="b" * 40), "CANDIDATE_OCI_REVISION_DIVERGED"),
            ):
                with self.subTest(reason=reason), self.assertRaisesRegex(deploy.DeployStop, reason):
                    deploy.prove_image(
                        ImageRunner(metadata),
                        CANDIDATE,
                        credentials_path=credentials,
                        policy=deploy.MetadataPolicy(uid=None, gid=None),
                        application_source_sha=APPLICATION_SOURCE_SHA,
                    )


class MigrationTests(unittest.TestCase):
    def test_parses_exact_production_inventory(self):
        source = "".join(
            f"[X] {database_id} {name}\n"
            for database_id, name in enumerate(PRODUCTION_MIGRATIONS, start=1)
        )
        self.assertEqual(
            deploy.parse_migration_inventory(source),
            (PRODUCTION_MIGRATIONS, ()),
        )

    def test_parses_executed_and_pending_inventory(self):
        executed = PRODUCTION_MIGRATIONS[:10]
        source = "".join(
            f"[X] {database_id} {name}\n"
            for database_id, name in enumerate(executed, start=1)
        )
        source += "[ ] FutureMigration1790000000000\n"
        self.assertEqual(
            deploy.parse_migration_inventory(source),
            (executed, ("FutureMigration1790000000000",)),
        )

    def test_preserves_typeorm_order_without_requiring_consecutive_ids(self):
        self.assertEqual(
            deploy.parse_migration_inventory(
                "\x1b[32m[X] 7 First1780000000000\x1b[0m\n"
                "[X] 42 Second1790000000000\n"
            ),
            (("First1780000000000", "Second1790000000000"), ()),
        )

    def test_rejects_ambiguous_inventory(self):
        for source in (
            "",
            "noise\n",
            "[X] Existing\n",
            "[X] abc Existing\n",
            "[X] 1\n",
            "[X] 0 Existing\n",
            "[X] 01 Existing\n",
            "[ ] 1 Pending\n",
            "[X] 1 Duplicate\n[X] 2 Duplicate\n",
            "[X] 1 Duplicate\n[ ] Duplicate\n",
            "noise\n[X] 1 Existing\n",
            "[X] 1 Existing\nnoise\n",
        ):
            with self.subTest(source=source), self.assertRaisesRegex(deploy.DeployStop, "AMBIGUOUS_MIGRATION_INVENTORY"):
                deploy.parse_migration_inventory(source)

    def test_post_migration_inventory_must_be_exact_and_ordered(self):
        deploy.validate_migration_inventory_after(
            ("Existing",),
            ("Pending",),
            ("Existing", "Pending"),
            (),
        )
        for observed, pending in (
            (("Unexpected", "Existing", "Pending"), ()),
            (("Pending",), ()),
            (("Pending", "Existing"), ()),
            (("Existing", "Pending", "Pending"), ()),
            (("Existing", "Pending"), ("StillPending",)),
        ):
            with self.subTest(observed=observed, pending=pending):
                with self.assertRaisesRegex(
                    deploy.DeployStop,
                    "MIGRATION_INVENTORY_MISMATCH",
                ):
                    deploy.validate_migration_inventory_after(
                        ("Existing",),
                        ("Pending",),
                        observed,
                        pending,
                    )

    def test_never_contains_migration_revert(self):
        self.assertNotIn("migration:revert", MODULE_PATH.read_text(encoding="utf-8"))


class FakeHeaders(email.message.Message):
    pass


class FakeResponse:
    def __init__(self, status, payload=b"", cookies=()):
        self.status = status
        self.payload = payload
        self.headers = FakeHeaders()
        self.headers["Cache-Control"] = "no-store"
        for cookie in cookies:
            self.headers["Set-Cookie"] = cookie

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


class FakeOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return self.responses.pop(0)


class RedirectingHttpsHandler(urllib.request.HTTPSHandler):
    def __init__(self, target):
        super().__init__()
        self.target = target
        self.requests = []

    def https_open(self, request):
        self.requests.append(request)
        headers = FakeHeaders()
        headers["Location"] = self.target
        response = urllib.response.addinfourl(
            io.BytesIO(b""), headers, request.full_url, 302
        )
        response.msg = "Found"
        return response


def json_response(payload, cookies=()):
    return FakeResponse(200, json.dumps(payload).encode(), cookies)


def valid_kanban():
    columns = []
    for stage in deploy.EXPECTED_STAGES:
        columns.append({"stage": stage, "total": 0, "expectedValueTotalMinor": "0", "withoutExpectedValue": 0, "items": [], "page": {"limit": 20, "nextCursor": None}})
    return {"currency": "BRL", "asOf": "2026-09-03T12:00:00Z", "expectedValueTotalMinor": "0", "withoutExpectedValue": 0, "columns": columns}


class SmokeTests(unittest.TestCase):
    def test_redirects_fail_before_forwarding_credentials_or_authorization(self):
        cases = (
            {
                "target": "https://attacker.example.invalid/collect",
                "method": "POST",
                "path": "/api/v1/auth/login",
                "headers": {
                    "Origin": "https://app.agenciagenesismkt.com.br",
                    "X-CSRF-Token": "A" * 43,
                },
                "payload": {
                    "email": "fixture@example.com",
                    "password": "secret-password",
                },
            },
            {
                "target": "http://app.agenciagenesismkt.com.br/api/v1/auth/bootstrap",
                "method": "GET",
                "path": "/api/v1/auth/bootstrap",
                "headers": {"Authorization": "Bearer secret-access"},
                "payload": None,
            },
        )
        for case in cases:
            with self.subTest(target=case["target"]):
                transport = RedirectingHttpsHandler(case["target"])
                opener = urllib.request.build_opener(
                    transport,
                    deploy.RejectRedirectHandler(),
                )
                client = deploy.SmokeClient(Path("unused"), opener=opener)
                with self.assertRaisesRegex(
                    deploy.DeployStop,
                    "FUNCTIONAL_SMOKE_REDIRECT_FORBIDDEN",
                ):
                    client.request(
                        case["method"],
                        case["path"],
                        headers=case["headers"],
                        payload=case["payload"],
                    )
                self.assertEqual(len(transport.requests), 1)
                self.assertEqual(
                    transport.requests[0].full_url,
                    f"https://app.agenciagenesismkt.com.br{case['path']}",
                )
                self.assertNotEqual(
                    transport.requests[0].full_url,
                    case["target"],
                )
                if case["payload"] is None:
                    self.assertEqual(
                        transport.requests[0].get_header("Authorization"),
                        "Bearer secret-access",
                    )
                else:
                    self.assertIn(
                        b'"password": "secret-password"',
                        transport.requests[0].data,
                    )

    def test_full_smoke_uses_only_same_origin_and_validates_protocol(self):
        token = "A" * 43
        user_id = "00000000-0000-4000-8000-000000000001"
        organization_id = "00000000-0000-4000-8000-000000000002"
        membership_id = "00000000-0000-4000-8000-000000000003"
        responses = [
            json_response({"csrfToken": token}, (f"__Host-genesis_csrf={token}; Secure; SameSite=Lax; Path=/",)),
            json_response({"accessToken": "secret-access", "tokenType": "Bearer", "expiresIn": 900, "user": {"id": user_id, "status": "active"}}, ("__Host-genesis_refresh=secret-refresh; HttpOnly; Secure; SameSite=Lax; Path=/",)),
            json_response({"user": {"id": user_id}, "organizations": [{"id": organization_id, "membershipId": membership_id, "name": "Fixture", "slug": "fixture", "role": "owner"}]}),
            json_response(valid_kanban()),
            FakeResponse(204, b"", ("__Host-genesis_csrf=; Max-Age=0; Secure; SameSite=Lax; Path=/", "__Host-genesis_refresh=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/")),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            credentials = Path(temporary) / "smoke.json"
            credentials.write_text(json.dumps({"email": "fixture@example.com", "password": "never-log"}), encoding="utf-8")
            chmod(credentials, 0o600)
            opener = FakeOpener(responses)
            records = deploy.SmokeClient(credentials, opener=opener, policy=deploy.MetadataPolicy(uid=None, gid=None)).full()
        self.assertEqual([record["category"] for record in records], ["csrf", "login", "bootstrap", "kanban", "logout"])
        self.assertTrue(all(request.full_url.startswith("https://app.agenciagenesismkt.com.br/api/v1/") for request in opener.requests))
        self.assertTrue(all("api.agenciagenesismkt.com.br/api/v1" not in request.full_url for request in opener.requests))

    def test_kanban_rejects_financial_and_stage_regressions(self):
        for mutate in (
            lambda value: value.update(currency="USD"),
            lambda value: value.update(expectedValueTotalMinor=-1),
            lambda value: value["columns"].reverse(),
            lambda value: value["columns"][0].update(items=[{"status": "inactive", "stage": "new"}]),
        ):
            value = valid_kanban()
            mutate(value)
            with self.assertRaisesRegex(deploy.DeployStop, "SMOKE_KANBAN_FAILED"):
                deploy.validate_kanban(value)


class ObservationLogTests(unittest.TestCase):
    def test_5xx_detection_reads_only_contracted_status_field(self):
        self.assertFalse(
            deploy.traefik_log_has_5xx(
                json.dumps({"Duration": 503, "DownstreamStatus": 200})
            )
        )
        self.assertTrue(
            deploy.traefik_log_has_5xx(
                json.dumps({"Duration": 1, "DownstreamStatus": 503})
            )
        )

    def test_malformed_json_or_status_fails_as_parse_error(self):
        for source in (
            "not-json",
            json.dumps({"DownstreamStatus": "503"}),
        ):
            with self.subTest(source=source), self.assertRaisesRegex(
                deploy.DeployStop,
                "OBSERVABILITY_LOG_PARSE_FAILED",
            ):
                deploy.traefik_log_has_5xx(source)


class EvidenceTests(unittest.TestCase):
    def test_progressive_atomic_evidence_and_first_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            chmod(root, 0o700)
            path = root / "run.json"
            store = deploy.EvidenceStore(
                path,
                deploy.new_evidence(
                    "a" * 16,
                    1,
                    APPLICATION_SOURCE_SHA,
                    OPERATIONAL_SOURCE_SHA,
                    CANDIDATE,
                ),
                uid=None,
                gid=None,
            )
            self.assertEqual(json.loads(path.read_text())["result"], "STARTED")
            store.update(result="KEEP")
            store.fail_once("ORIGINAL_FAILURE")
            store.fail_once("LATER_FAILURE")
            store.rollback("FAILED", "ROLLBACK_FAILED")
            payload = json.loads(path.read_text())
            self.assertEqual(payload["failureReasonCode"], "ORIGINAL_FAILURE")
            self.assertEqual(payload["rollbackReasonCode"], "ROLLBACK_FAILED")
            self.assertEqual(list(root.glob(".run.json.*")), [])
            with self.assertRaisesRegex(
                deploy.DeployStop, "EVIDENCE_RUN_ALREADY_EXISTS"
            ):
                deploy.EvidenceStore(
                    path,
                    deploy.new_evidence(
                        "a" * 16,
                        1,
                        APPLICATION_SOURCE_SHA,
                        OPERATIONAL_SOURCE_SHA,
                        CANDIDATE,
                    ),
                    uid=None,
                    gid=None,
                )

    def test_evidence_fault_before_replace_preserves_previous_generation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            chmod(root, 0o700)
            path = root / "run.json"
            store = deploy.EvidenceStore(
                path,
                deploy.new_evidence(
                    "a" * 16,
                    1,
                    APPLICATION_SOURCE_SHA,
                    OPERATIONAL_SOURCE_SHA,
                    CANDIDATE,
                ),
                uid=None,
                gid=None,
            )
            before = path.read_bytes()

            def fail(stage, _path):
                if stage == "before_replace":
                    raise RuntimeError("fault")

            store.hook = fail
            with self.assertRaisesRegex(RuntimeError, "fault"):
                store.update(result="KEEP")
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(root.glob(".run.json.*")), [])

    def test_evidence_rejects_sensitive_keys_and_bearer_values(self):
        for value in ({"password": "x"}, {"safe": "Bearer x"}, {"body": {}}):
            with self.assertRaisesRegex(deploy.DeployStop, "EVIDENCE_REDACTION_FAILED"):
                deploy.validate_redacted_evidence(value)

    def test_release_evidence_binds_candidate_and_level_two_pending(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "release.json"
            path.write_text(
                json.dumps(
                    {
                        "applicationSourceSha": APPLICATION_SOURCE_SHA,
                        "operationalSourceSha": OPERATIONAL_SOURCE_SHA,
                        "candidateImage": CANDIDATE,
                        "status": "approved",
                        "approvedLevel2Pending": ["MigrationOne"],
                    }
                ),
                encoding="utf-8",
            )
            chmod(path, 0o600)
            self.assertEqual(
                deploy.prove_release_evidence(
                    path,
                    APPLICATION_SOURCE_SHA,
                    OPERATIONAL_SOURCE_SHA,
                    CANDIDATE,
                    deploy.MetadataPolicy(uid=None, gid=None),
                ),
                ("MigrationOne",),
            )
            payload = json.loads(path.read_text())
            payload["candidateImage"] = PREVIOUS
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(
                deploy.DeployStop, "RELEASE_EVIDENCE_INVALID"
            ):
                deploy.prove_release_evidence(
                    path,
                    APPLICATION_SOURCE_SHA,
                    OPERATIONAL_SOURCE_SHA,
                    CANDIDATE,
                    deploy.MetadataPolicy(uid=None, gid=None),
                )
            payload["candidateImage"] = CANDIDATE
            payload["operationalSourceSha"] = "c" * 40
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(
                deploy.DeployStop,
                "RELEASE_EVIDENCE_INVALID",
            ):
                deploy.prove_release_evidence(
                    path,
                    APPLICATION_SOURCE_SHA,
                    OPERATIONAL_SOURCE_SHA,
                    CANDIDATE,
                    deploy.MetadataPolicy(uid=None, gid=None),
                )


class FakeCompose:
    def __init__(self, inventories=None, fail_recreate_after=None, fail_migrate=False):
        self.inventories = list(inventories or [((), ())])
        self.migrate_calls = 0
        self.recreate_calls = []
        self.render_calls = []
        self.fail_recreate_after = fail_recreate_after
        self.fail_migrate = fail_migrate

    def render(self, expected_image, **_kwargs):
        self.render_calls.append((expected_image, _kwargs))
        return rendered(expected_image)

    def migration_inventory(self, _candidate):
        return self.inventories.pop(0)

    def migrate(self, _candidate):
        self.migrate_calls += 1
        if self.fail_migrate:
            raise deploy.DeployStop("MIGRATION_FAILED")

    def recreate_api(self):
        self.recreate_calls.append("pointer")
        if self.fail_recreate_after is not None and len(self.recreate_calls) >= self.fail_recreate_after:
            raise deploy.DeployStop("RECREATE_FAILED")

    def service_id(self, service):
        return {
            "api": "new-api",
            "postgres": "postgres",
            "traefik": "traefik",
        }[service]


class DummyLock:
    def __init__(self, *_args, **_kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


class PreflightCompose:
    def __init__(self):
        self.inventory_images = []

    def render(self, expected_image):
        return rendered(expected_image)

    def service_id(self, service):
        return {
            "api": "api-container",
            "postgres": "postgres-container",
            "traefik": "traefik-container",
        }[service]

    def migration_inventory(self, image):
        self.inventory_images.append(image)
        return (("Existing",), ())


class PreflightTests(unittest.TestCase):
    def test_preflight_uses_runtime_authority_and_read_only_inventory(self):
        compose = PreflightCompose()
        states = {
            "api-container": deploy.ContainerState(
                "api-container", PREVIOUS, "running", "healthy", 0
            ),
            "postgres-container": deploy.ContainerState(
                "postgres-container",
                "postgres@sha256:" + "3" * 64,
                "running",
                "healthy",
                0,
                ("genesis-postgres-data",),
            ),
            "traefik-container": deploy.ContainerState(
                "traefik-container",
                "traefik@sha256:" + "4" * 64,
                "running",
                None,
                0,
            ),
        }
        with (
            mock.patch.object(deploy.sys, "platform", "linux"),
            mock.patch.object(deploy.platform, "machine", return_value="x86_64"),
            mock.patch.object(deploy.platform, "node", return_value="fixture"),
            mock.patch.object(
                deploy,
                "verify_operational_integrity",
                return_value={key: "value" for key in deploy.PRODUCTION_ENV_KEYS},
            ),
            mock.patch.object(deploy, "read_pointer", return_value=PREVIOUS),
            mock.patch.object(deploy, "validate_secret_metadata"),
            mock.patch.object(deploy, "validate_regular_metadata"),
            mock.patch.object(deploy, "prove_release_evidence", return_value=()),
            mock.patch.object(
                deploy.shutil,
                "disk_usage",
                return_value=types.SimpleNamespace(free=10_000),
            ),
            mock.patch.object(deploy, "ComposeClient", return_value=compose),
            mock.patch.object(
                deploy,
                "inspect_container",
                side_effect=lambda _runner, container: states[container],
            ),
        ):
            snapshot, returned_compose = deploy.preflight(
                RecordingRunner(),
                deploy.DeploymentPaths(),
                APPLICATION_SOURCE_SHA,
                OPERATIONAL_SOURCE_SHA,
                CANDIDATE,
                expected_hostname="fixture",
                minimum_free_bytes=1,
                policy=deploy.MetadataPolicy(uid=None, gid=None),
            )
        self.assertEqual(snapshot.previous_image, PREVIOUS)
        self.assertIs(returned_compose, compose)
        self.assertEqual(compose.inventory_images, [PREVIOUS])


class FakeSmoke:
    def __init__(self, fail_full=False):
        self.fail_full = fail_full

    def full(self):
        if self.fail_full:
            raise deploy.DeployStop("SMOKE_FAILED")
        return [{"category": "smoke", "status": 200, "assertion": "PASS", "reasonCode": None}]

    def compatibility(self):
        return [{"category": "rollback", "status": 200, "assertion": "PASS", "reasonCode": None}]


class RuntimeHealthWaitTests(unittest.TestCase):
    @staticmethod
    def compose():
        return types.SimpleNamespace(service_id=lambda service: "api-container")

    def test_waits_only_while_starting_and_returns_healthy(self):
        states = [
            deploy.ContainerState("api-container", CANDIDATE, "running", "starting", 0),
            deploy.ContainerState("api-container", CANDIDATE, "running", "starting", 0),
            deploy.ContainerState("api-container", CANDIDATE, "running", "healthy", 0),
        ]
        sleeps = []
        with mock.patch.object(deploy, "inspect_container", side_effect=states):
            state = deploy.wait_for_runtime_healthy(
                RecordingRunner(),
                self.compose(),
                CANDIDATE,
                sleep=sleeps.append,
                monotonic=lambda: 0,
            )
        self.assertEqual(state.health, "healthy")
        self.assertEqual(sleeps, [deploy.API_HEALTH_POLL_INTERVAL_SECONDS] * 2)

    def test_immediate_healthy_does_not_sleep(self):
        sleep = mock.Mock()
        state = deploy.ContainerState("api-container", CANDIDATE, "running", "healthy", 0)
        with mock.patch.object(deploy, "inspect_container", return_value=state):
            result = deploy.wait_for_runtime_healthy(
                RecordingRunner(), self.compose(), CANDIDATE, sleep=sleep
            )
        self.assertIs(result, state)
        sleep.assert_not_called()

    def test_unhealthy_fails_immediately(self):
        sleep = mock.Mock()
        state = deploy.ContainerState("api-container", CANDIDATE, "running", "unhealthy", 0)
        with mock.patch.object(deploy, "inspect_container", return_value=state):
            with self.assertRaisesRegex(deploy.DeployStop, "API_NOT_HEALTHY"):
                deploy.wait_for_runtime_healthy(
                    RecordingRunner(), self.compose(), CANDIDATE, sleep=sleep
                )
        sleep.assert_not_called()

    def test_exited_fails_immediately(self):
        sleep = mock.Mock()
        state = deploy.ContainerState("api-container", CANDIDATE, "exited", "starting", 0)
        with mock.patch.object(deploy, "inspect_container", return_value=state):
            with self.assertRaisesRegex(deploy.DeployStop, "API_NOT_HEALTHY"):
                deploy.wait_for_runtime_healthy(
                    RecordingRunner(), self.compose(), CANDIDATE, sleep=sleep
                )
        sleep.assert_not_called()

    def test_wrong_digest_fails_immediately_even_when_healthy(self):
        sleep = mock.Mock()
        state = deploy.ContainerState("api-container", PREVIOUS, "running", "healthy", 0)
        with mock.patch.object(deploy, "inspect_container", return_value=state):
            with self.assertRaisesRegex(deploy.DeployStop, "RUNTIME_IMAGE_DIVERGED"):
                deploy.wait_for_runtime_healthy(
                    RecordingRunner(), self.compose(), CANDIDATE, sleep=sleep
                )
        sleep.assert_not_called()

    def test_missing_health_fails_immediately(self):
        sleep = mock.Mock()
        state = deploy.ContainerState("api-container", CANDIDATE, "running", None, 0)
        with mock.patch.object(deploy, "inspect_container", return_value=state):
            with self.assertRaisesRegex(deploy.DeployStop, "API_NOT_HEALTHY"):
                deploy.wait_for_runtime_healthy(
                    RecordingRunner(), self.compose(), CANDIDATE, sleep=sleep
                )
        sleep.assert_not_called()

    def test_starting_at_deadline_fails_with_health_timeout(self):
        clock = {"now": 0}
        sleeps = []
        state = deploy.ContainerState("api-container", CANDIDATE, "running", "starting", 0)

        def sleep(seconds):
            sleeps.append(seconds)
            clock["now"] = deploy.API_HEALTH_WAIT_TIMEOUT_SECONDS

        with mock.patch.object(deploy, "inspect_container", return_value=state):
            with self.assertRaisesRegex(deploy.DeployStop, "API_HEALTH_TIMEOUT"):
                deploy.wait_for_runtime_healthy(
                    RecordingRunner(),
                    self.compose(),
                    CANDIDATE,
                    sleep=sleep,
                    monotonic=lambda: clock["now"],
                )
        self.assertEqual(sleeps, [deploy.API_HEALTH_POLL_INTERVAL_SECONDS])


class FlowTests(unittest.TestCase):
    def run_flow(self, compose, *, level=1, expected_pending=(), smoke=None, candidate=CANDIDATE, checkpoint_error=None, runtime_states=None):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        evidence = root / "evidence"
        lock_parent = root / "lock"
        lock_parent.mkdir(mode=0o700)
        paths = deploy.DeploymentPaths(evidence_root=evidence, lock=lock_parent / "deploy.lock", pointer=root / "api-image.env")
        snapshot = deploy.PreflightSnapshot(
            PREVIOUS,
            deploy.ContainerState("old-api", PREVIOUS, "running", "healthy", 0),
            deploy.ContainerState("postgres", "postgres@sha256:" + "3" * 64, "running", "healthy", 0),
            deploy.ContainerState("traefik", "traefik@sha256:" + "4" * 64, "running", None, 0),
            "postgres",
            "traefik",
        )
        pointer_state = {"image": PREVIOUS}

        def write_pointer(_path, image, **_kwargs):
            pointer_state["image"] = image

        compose.pointer_updates = []

        def recording_write_pointer(path, image, **kwargs):
            compose.pointer_updates.append(image)
            write_pointer(path, image, **kwargs)

        states = iter(runtime_states) if runtime_states is not None else None

        def inspect_runtime(_runner, _container_id):
            if states is not None:
                return next(states)
            return deploy.ContainerState(
                "new-api", pointer_state["image"], "running", "healthy", 0
            )

        compose.sleep_calls = []

        patchers = [
            mock.patch.object(deploy, "DeploymentLock", DummyLock),
            mock.patch.object(deploy, "preflight", return_value=(snapshot, compose)),
            mock.patch.object(
                deploy,
                "prove_release_evidence",
                return_value=tuple(expected_pending),
            ),
            mock.patch.object(deploy, "prove_image"),
            mock.patch.object(deploy, "write_pointer", side_effect=recording_write_pointer),
            mock.patch.object(
                deploy,
                "read_pointer",
                side_effect=lambda *_args, **_kwargs: pointer_state["image"],
            ),
            mock.patch.object(deploy, "verify_dependencies", return_value="new-api"),
            mock.patch.object(deploy, "inspect_container", side_effect=inspect_runtime),
            mock.patch.object(deploy, "observe"),
            mock.patch.object(deploy, "run_checkpoint"),
        ]
        started = [patcher.start() for patcher in patchers]
        checkpoint_mock = started[-1]
        checkpoint_mock.side_effect = checkpoint_error
        self.addCleanup(lambda: [patcher.stop() for patcher in reversed(patchers)])
        result = deploy.execute_deployment(
            RecordingRunner(), paths,
            run_id="a" * 16,
            application_source_sha=APPLICATION_SOURCE_SHA,
            operational_source_sha=OPERATIONAL_SOURCE_SHA,
            candidate_image=candidate,
            level=level, expected_pending=expected_pending,
            authorization=deploy.authorization_value(
                "a" * 16,
                APPLICATION_SOURCE_SHA,
                OPERATIONAL_SOURCE_SHA,
                candidate,
                level,
            ),
            expected_hostname="fixture", minimum_free_bytes=0,
            policy=deploy.MetadataPolicy(uid=None, gid=None),
            smoke_factory=lambda: smoke or FakeSmoke(), sleep=compose.sleep_calls.append,
        )
        return temporary, result, checkpoint_mock

    def test_level_one_keep_and_no_migration(self):
        compose = FakeCompose([((), ())])
        temporary, result, checkpoint = self.run_flow(compose)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "KEEP")
        self.assertEqual(compose.migrate_calls, 0)
        checkpoint.assert_not_called()

    def test_level_one_pending_stops_before_promotion(self):
        compose = FakeCompose([(("Existing",), ("Pending",))])
        temporary, result, _checkpoint = self.run_flow(compose)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "STOP")
        self.assertEqual(result["failureReasonCode"], "LEVEL_1_PENDING_MIGRATIONS")
        self.assertEqual(compose.recreate_calls, [])

    def test_level_two_checkpoint_migration_and_inventory(self):
        compose = FakeCompose([(("Existing",), ("Pending",)), (("Existing", "Pending"), ())])
        temporary, result, checkpoint = self.run_flow(compose, level=2, expected_pending=("Pending",))
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "KEEP")
        self.assertEqual(compose.migrate_calls, 1)
        checkpoint.assert_called_once()

    def test_level_two_checkpoint_and_migration_fail_before_promotion(self):
        compose = FakeCompose([(("Existing",), ("Pending",))])
        temporary, result, _checkpoint = self.run_flow(
            compose,
            level=2,
            expected_pending=("Pending",),
            checkpoint_error=deploy.DeployStop("CHECKPOINT_FAILED"),
        )
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["failureReasonCode"], "CHECKPOINT_FAILED")
        self.assertEqual(compose.recreate_calls, [])
        compose = FakeCompose([(("Existing",), ("Pending",))], fail_migrate=True)
        temporary, result, _checkpoint = self.run_flow(
            compose, level=2, expected_pending=("Pending",)
        )
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["failureReasonCode"], "MIGRATION_FAILED")
        self.assertEqual(compose.recreate_calls, [])

    def test_pre_promotion_timeout_stops_without_pointer_change(self):
        class TimeoutMigrationCompose(FakeCompose):
            def migrate(self, _candidate):
                raise deploy.DeployStop("SUBPROCESS_TIMEOUT")

        compose = TimeoutMigrationCompose([(("Existing",), ("Pending",))])
        temporary, result, _checkpoint = self.run_flow(
            compose,
            level=2,
            expected_pending=("Pending",),
        )
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "STOP")
        self.assertEqual(result["failureReasonCode"], "SUBPROCESS_TIMEOUT")
        self.assertEqual(compose.pointer_updates, [])
        self.assertEqual(compose.recreate_calls, [])

    def test_candidate_equal_previous_is_noop(self):
        compose = FakeCompose()
        temporary, result, checkpoint = self.run_flow(compose, candidate=PREVIOUS)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "NOOP")
        self.assertEqual(compose.recreate_calls, [])
        checkpoint.assert_not_called()

    def test_post_promotion_failure_rolls_back_and_preserves_first_failure(self):
        compose = FakeCompose([((), ())])
        temporary, result, _checkpoint = self.run_flow(compose, smoke=FakeSmoke(fail_full=True))
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "ROLLBACK")
        self.assertEqual(result["failureReasonCode"], "SMOKE_FAILED")
        self.assertEqual(result["rollbackResult"], "PASS")
        self.assertEqual(compose.recreate_calls, ["pointer", "pointer"])
        self.assertEqual(compose.pointer_updates, [CANDIDATE, PREVIOUS])
        self.assertTrue(
            all("candidate_image" not in options for _, options in compose.render_calls)
        )

    def test_rollback_failure_keeps_original_reason(self):
        compose = FakeCompose([((), ())], fail_recreate_after=2)
        temporary, result, _checkpoint = self.run_flow(compose, smoke=FakeSmoke(fail_full=True))
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "ROLLBACK_FAILED")
        self.assertEqual(result["failureReasonCode"], "SMOKE_FAILED")
        self.assertEqual(result["rollbackReasonCode"], "ROLLBACK_FAILED")

    def test_rollback_waits_for_previous_to_transition_from_starting_to_healthy(self):
        compose = FakeCompose([((), ())])
        states = [
            deploy.ContainerState("new-api", CANDIDATE, "running", "healthy", 0),
            deploy.ContainerState("new-api", PREVIOUS, "running", "starting", 0),
            deploy.ContainerState("new-api", PREVIOUS, "running", "healthy", 0),
        ]
        temporary, result, _checkpoint = self.run_flow(
            compose,
            smoke=FakeSmoke(fail_full=True),
            runtime_states=states,
        )
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "ROLLBACK")
        self.assertEqual(result["failureReasonCode"], "SMOKE_FAILED")
        self.assertEqual(result["rollbackResult"], "PASS")
        self.assertEqual(compose.sleep_calls, [deploy.API_HEALTH_POLL_INTERVAL_SECONDS])

    def test_rollback_unhealthy_preserves_original_failure(self):
        compose = FakeCompose([((), ())])
        states = [
            deploy.ContainerState("new-api", CANDIDATE, "running", "healthy", 0),
            deploy.ContainerState("new-api", PREVIOUS, "running", "unhealthy", 0),
        ]
        temporary, result, _checkpoint = self.run_flow(
            compose,
            smoke=FakeSmoke(fail_full=True),
            runtime_states=states,
        )
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "ROLLBACK_FAILED")
        self.assertEqual(result["failureReasonCode"], "SMOKE_FAILED")
        self.assertEqual(result["rollbackReasonCode"], "ROLLBACK_FAILED")
        self.assertEqual(compose.sleep_calls, [])

    def test_post_promotion_timeout_preserves_failure_and_rolls_back(self):
        class TimeoutOnceCompose(FakeCompose):
            def recreate_api(self):
                super().recreate_api()
                if len(self.recreate_calls) == 1:
                    raise deploy.DeployStop("SUBPROCESS_TIMEOUT")

        compose = TimeoutOnceCompose([((), ())])
        temporary, result, _checkpoint = self.run_flow(compose)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "ROLLBACK")
        self.assertEqual(result["failureReasonCode"], "SUBPROCESS_TIMEOUT")
        self.assertEqual(result["rollbackResult"], "PASS")
        self.assertEqual(compose.pointer_updates, [CANDIDATE, PREVIOUS])

    def test_evidence_failure_after_promotion_cannot_preempt_runtime_rollback(self):
        compose = FakeCompose([((), ())])
        original_write = deploy.EvidenceStore._write
        write_count = 0

        def persistently_fail_after_promotion(store):
            nonlocal write_count
            write_count += 1
            if write_count >= 4:
                raise OSError("evidence storage unavailable")
            return original_write(store)

        with mock.patch.object(
            deploy.EvidenceStore,
            "_write",
            new=persistently_fail_after_promotion,
        ):
            temporary, result, _checkpoint = self.run_flow(compose)
        self.addCleanup(temporary.cleanup)
        self.assertEqual(result["result"], "ROLLBACK")
        self.assertEqual(result["failureReasonCode"], "UNEXPECTED_DEPLOYMENT_FAILURE")
        self.assertEqual(result["rollbackResult"], "PASS")
        self.assertEqual(compose.pointer_updates, [CANDIDATE, PREVIOUS])
        self.assertEqual(compose.recreate_calls, ["pointer", "pointer"])
        self.assertGreaterEqual(write_count, 5)

    def test_dependency_identity_guard(self):
        class IdCompose:
            def __init__(self):
                self.ids = {"postgres": "postgres", "traefik": "traefik", "api": "new-api"}

            def service_id(self, service):
                return self.ids[service]

        compose = IdCompose()
        snapshot = deploy.PreflightSnapshot(
            PREVIOUS,
            deploy.ContainerState("old-api", PREVIOUS, "running", "healthy", 0),
            deploy.ContainerState("postgres", "postgres", "running", "healthy", 0),
            deploy.ContainerState("traefik", "traefik", "running", None, 0),
            "postgres",
            "traefik",
        )
        self.assertEqual(deploy.verify_dependencies(compose, snapshot), "new-api")
        compose.ids["postgres"] = "changed"
        with self.assertRaisesRegex(deploy.DeployStop, "POSTGRES_CONTAINER_CHANGED"):
            deploy.verify_dependencies(compose, snapshot)

    def test_level_three_and_unbound_authorization_stop(self):
        with self.assertRaisesRegex(deploy.DeployStop, "LEVEL_3_REQUIRES_SEPARATE_ARCHITECTURE"):
            deploy.execute_deployment(RecordingRunner(), deploy.DeploymentPaths(), run_id="a" * 16, application_source_sha=APPLICATION_SOURCE_SHA, operational_source_sha=OPERATIONAL_SOURCE_SHA, candidate_image=CANDIDATE, level=3, expected_pending=(), authorization="", expected_hostname="fixture", minimum_free_bytes=0)
        with self.assertRaisesRegex(deploy.DeployStop, "PRODUCTION_MUTATION_NOT_AUTHORIZED"):
            deploy.execute_deployment(RecordingRunner(), deploy.DeploymentPaths(), run_id="a" * 16, application_source_sha=APPLICATION_SOURCE_SHA, operational_source_sha=OPERATIONAL_SOURCE_SHA, candidate_image=CANDIDATE, level=1, expected_pending=(), authorization="wrong", expected_hostname="fixture", minimum_free_bytes=0)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux mechanism contract")
class LinuxMechanismTests(unittest.TestCase):
    @unittest.skipUnless(
        getattr(os, "geteuid", lambda: -1)() == 0,
        "Exact /run lock contract requires a disposable root Linux runner",
    )
    def test_default_run_lock_path_acquisition_exclusion_release_and_reuse(self):
        lock = deploy.LOCK_PATH
        self.assertEqual(lock, Path("/run/genesis-api-deploy.lock"))
        self.assertFalse(lock.exists() or lock.is_symlink())
        parent = lock.parent.lstat()
        self.assertTrue(stat.S_ISDIR(parent.st_mode))
        self.assertFalse(lock.parent.is_symlink())
        self.assertEqual((parent.st_uid, parent.st_gid), (0, 0))
        self.assertEqual(stat.S_IMODE(parent.st_mode) & 0o022, 0)
        policy = deploy.MetadataPolicy(uid=0, gid=0)
        created = False
        try:
            deploy.probe_deployment_lock(lock, policy)
            self.assertFalse(lock.exists())
            with deploy.DeploymentLock(lock, policy):
                created = True
                metadata = lock.lstat()
                self.assertTrue(stat.S_ISREG(metadata.st_mode))
                self.assertEqual(stat.S_IMODE(metadata.st_mode), 0o600)
                self.assertEqual((metadata.st_uid, metadata.st_gid), (0, 0))
                self.assertEqual(metadata.st_nlink, 1)
                with self.assertRaisesRegex(
                    deploy.DeployStop,
                    "DEPLOYMENT_LOCK_HELD",
                ):
                    with deploy.DeploymentLock(lock, policy):
                        pass
                with self.assertRaisesRegex(
                    deploy.DeployStop,
                    "DEPLOYMENT_LOCK_HELD",
                ):
                    deploy.probe_deployment_lock(lock, policy)
            self.assertTrue(lock.exists())
            deploy.probe_deployment_lock(lock, policy)
            with deploy.DeploymentLock(lock, policy):
                pass
        finally:
            if created:
                metadata = lock.lstat()
                self.assertTrue(stat.S_ISREG(metadata.st_mode))
                self.assertEqual((metadata.st_uid, metadata.st_gid), (0, 0))
                self.assertEqual(metadata.st_nlink, 1)
                lock.unlink()
        self.assertFalse(lock.exists())

    def test_real_flock_modes_fsync_replace_and_subprocess(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            chmod(root, 0o700)
            unsafe_parent = root / "unsafe-lock-parent"
            unsafe_parent.mkdir()
            chmod(unsafe_parent, 0o1777)
            unsafe_lock = unsafe_parent / "deploy.lock"
            policy = deploy.MetadataPolicy(os.getuid(), os.getgid())
            with self.assertRaisesRegex(
                deploy.DeployStop,
                "UNSAFE_PARENT_DIRECTORY",
            ):
                deploy.probe_deployment_lock(unsafe_lock, policy)
            self.assertFalse(unsafe_lock.exists())
            pointer = root / "api-image.env"
            deploy.write_pointer(pointer, PREVIOUS, uid=os.getuid(), gid=os.getgid())
            self.assertEqual(stat.S_IMODE(pointer.stat().st_mode), 0o600)
            self.assertEqual(deploy.read_pointer(pointer, policy=deploy.MetadataPolicy(os.getuid(), os.getgid())), PREVIOUS)
            lock = root / "deploy.lock"
            deploy.probe_deployment_lock(lock, policy)
            self.assertFalse(lock.exists())
            with deploy.DeploymentLock(lock, policy):
                with self.assertRaisesRegex(deploy.DeployStop, "DEPLOYMENT_LOCK_HELD"):
                    with deploy.DeploymentLock(lock, policy):
                        pass
                with self.assertRaisesRegex(
                    deploy.DeployStop,
                    "DEPLOYMENT_LOCK_HELD",
                ):
                    deploy.probe_deployment_lock(lock, policy)
                with self.assertRaisesRegex(
                    deploy.DeployStop,
                    "SUBPROCESS_TIMEOUT",
                ):
                    deploy.CommandRunner().run(
                        (
                            sys.executable,
                            "-c",
                            "import time; time.sleep(1)",
                        ),
                        timeout_seconds=0.01,
                    )
            with deploy.DeploymentLock(lock, policy):
                pass
            result = deploy.CommandRunner().run(("/bin/sh", "-c", "printf safe"), env={"PATH": os.environ["PATH"]})
            self.assertEqual(result.stdout, "safe")


if __name__ == "__main__":
    unittest.main(verbosity=2)
