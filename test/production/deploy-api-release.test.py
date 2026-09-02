#!/usr/bin/env python3
"""Adversarial, network-free tests for the versioned deployment operator."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import stat
import sys
import tarfile
import tempfile
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "docker/production/deploy-api-release.py"
SPEC = importlib.util.spec_from_file_location("deploy_api_release", MODULE_PATH)
assert SPEC and SPEC.loader
deploy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = deploy
SPEC.loader.exec_module(deploy)

CANDIDATE_IMAGE = "ghcr.io/example/genesis@sha256:" + "a" * 64
ROLLBACK_IMAGE = "ghcr.io/example/genesis@sha256:" + "b" * 64
SOURCE_COMMIT = "c" * 40
MIGRATIONS = [
    "Baseline1780000000000",
    "ManageLeadCommercialCycleExpectedValue1788289200000",
]


def write_bundle(root: Path, role: str, image: str) -> str:
    root.mkdir()
    operator = root / "docker/production/deploy-api-release.py"
    operator.parent.mkdir(parents=True)
    operator.write_bytes(MODULE_PATH.read_bytes())
    os.chmod(operator, 0o644)
    compose = root / "compose.production.yml"
    selected = CANDIDATE_IMAGE if role == "current" else ROLLBACK_IMAGE
    compose.write_text(f"api: {selected}\nmigrate: {selected}\n", encoding="utf-8")
    os.chmod(compose, 0o644)
    artifacts = []
    for path in ("compose.production.yml", "docker/production/deploy-api-release.py"):
        source = root / path
        artifacts.append({"path": path, "sha256": deploy.sha256_file(source), "mode": "0644"})
    manifest = {
        "bundleMode": "committed-release",
        "operational": True,
        "releaseRole": role,
        "sourceCommit": SOURCE_COMMIT,
        "images": {"api": {"reference": image}},
        "migrations": {
            "sourcePath": "src/database/migrations",
            "orderedNames": MIGRATIONS,
        },
        "artifacts": artifacts,
    }
    raw = deploy.canonical_json(manifest)
    (root / "release-manifest.json").write_bytes(raw)
    os.chmod(root / "release-manifest.json", 0o644)
    return "sha256:" + deploy.sha256_bytes(raw)


def make_plan(candidate_fingerprint: str, rollback_fingerprint: str) -> dict:
    return {
        "schemaVersion": deploy.SCHEMA_VERSION,
        "runId": "0123456789abcdef",
        "authorizationId": "AUTH:release:001",
        "sourceCommit": SOURCE_COMMIT,
        "host": {
            "sshAlias": "genesis-production",
            "hostname": "srv1870064",
            "architecture": "linux/amd64",
            "knownHostsFile": "/operator/known_hosts",
            "identityFile": "/operator/id_ed25519",
            "hostKeyFingerprint": "SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
        },
        "paths": {
            "activeRelease": "/opt/genesis/release",
            "remoteWorkspace": "/run/genesis-api-deploy-0123456789abcdef",
            "deploymentLock": "/run/lock/genesis-api-deployment.lock",
            "allowedExistingSiblings": [],
        },
        "candidate": {"image": CANDIDATE_IMAGE, "bundleFingerprint": candidate_fingerprint},
        "rollback": {"image": ROLLBACK_IMAGE, "bundleFingerprint": rollback_fingerprint},
        "baseline": {
            "activeBundleFingerprint": rollback_fingerprint,
            "liveImage": ROLLBACK_IMAGE,
            "volume": "genesis-postgres-data",
            "project": "genesis",
            "apiContainer": "genesis-api-1",
            "postgresContainer": "genesis-postgres-1",
            "traefikContainer": "genesis-traefik-1",
        },
        "migrations": {
            "database": "genesis",
            "bootstrapUser": "postgres",
            "appliedBefore": MIGRATIONS[:1],
            "pending": MIGRATIONS[1:],
            "postHead": "ManageLeadCommercialCycleExpectedValue1788289200000",
            "applicationRollbackCompatible": True,
        },
        "secrets": [
            {"purpose": "compose", "path": "/opt/genesis/secrets/database", "uid": 0, "gid": 70, "mode": "0440"},
            {"purpose": "registry", "path": "/opt/genesis/secrets/registry", "uid": 0, "gid": 0, "mode": "0400"},
            {"purpose": "smoke", "path": "/opt/genesis/secrets/smoke", "uid": 0, "gid": 0, "mode": "0400"},
        ],
        "smoke": {
            "baseUrl": "https://api.example.test",
            "credentialsFile": "/opt/genesis/secrets/smoke",
            "tenantProbePath": "/api/v1/auth/bootstrap",
            "kanbanPath": "/api/v1/leads/kanban?limit=20",
            "financialAssertions": {
                "currency": "BRL",
                "expectedValueTotalMinor": "decimal-string",
                "withoutExpectedValue": "integer",
                "stageAggregates": True,
                "cardExpectedValueMinor": "decimal-string-or-null",
            },
        },
        "observation": {"durationSeconds": 900, "checkpointsSeconds": [0, 120, 300, 600, 900]},
        "minimumFreeBytes": 268435456,
    }


class FakeRuntime:
    def __init__(self, plan: dict):
        self.plan = plan
        self.mutations = []
        self.state = "baseline"
        self.fail_at = None
        self.smoke_calls = 0
        self.observe_calls = 0

    def snapshot(self, plan, release_root):
        after = plan["migrations"]["appliedBefore"] + plan["migrations"]["pending"]
        candidate = self.state in {"candidate", "candidate-unhealthy"}
        rollback_after = self.state == "rollback-after"
        return {
            "hostname": "srv1870064",
            "architecture": "linux/amd64",
            "activeFingerprint": plan["candidate"]["bundleFingerprint"] if candidate else plan["rollback"]["bundleFingerprint"],
            "apiImage": plan["candidate"]["image"] if candidate else plan["rollback"]["image"],
            "apiState": "running",
            "apiHealth": "unhealthy" if self.state == "candidate-unhealthy" else "healthy",
            "apiRestarts": 0,
            "postgresId": "postgres-id",
            "postgresHealth": "healthy",
            "traefikId": "traefik-id",
            "traefikState": "running",
            "volume": "genesis-postgres-data",
            "migrations": after if self.state in {"migrated", "candidate", "candidate-unhealthy", "rollback-after"} else plan["migrations"]["appliedBefore"],
            "secretsValid": True,
            "freeBytes": plan["minimumFreeBytes"] + 1,
            "rollbackReady": candidate,
            "unexpectedStaging": [],
            "lockHeld": False,
        }

    def verify_pair(self, plan, current, rollback):
        return None

    def verify_active(self, plan, fingerprint, image, role="current"):
        return None

    def _action(self, action):
        self.mutations.append(action)
        if self.fail_at == action:
            raise deploy.StopBeforeMutation(action.upper() + "_FAILED")

    def registry_pull(self, plan):
        self._action("pull")

    def migrate(self, plan, release_root):
        self._action("migration")
        self.state = "migrated"

    def activate(self, plan, current, rollback):
        self._action("activation")
        self.state = "candidate"

    def recreate_api(self, plan, release_root):
        self._action("api-recreate")

    def smoke(self, plan, minimal=False):
        self.smoke_calls += 1
        if self.fail_at == "smoke" and not minimal:
            raise deploy.StopBeforeMutation("SMOKE_FAILED")

    def observe(self, plan):
        self.observe_calls += 1
        if self.fail_at == "observation":
            raise deploy.StopBeforeMutation("OBSERVATION_FAILED")
        if self.fail_at == "candidate-regression":
            self.state = "baseline"

    def rollback(self, plan):
        self._action("rollback")
        self.state = "rollback-after"


@contextlib.contextmanager
def fake_lock(_path):
    yield


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class OperatorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.current = self.root / "current"
        self.rollback = self.root / "rollback"
        current_fp = write_bundle(self.current, "current", CANDIDATE_IMAGE)
        rollback_fp = write_bundle(self.rollback, "rollback", ROLLBACK_IMAGE)
        self.plan = make_plan(current_fp, rollback_fp)
        self.plan_path = self.root / "plan.json"
        self.plan_path.write_bytes(deploy.canonical_json(self.plan))
        self.sha = deploy.plan_sha(self.plan_path)
        self.evidence_path = self.root / "evidence.jsonl"

    def tearDown(self):
        self.temp.cleanup()

    def evidence(self):
        return deploy.make_evidence(self.plan, self.sha, self.evidence_path, now=lambda: 0)

    def test_plan_and_pair_accept_exact_contract(self):
        self.assertEqual(deploy.validate_plan(self.plan), self.plan)
        deploy.validate_bundle_pair(self.current, self.rollback, self.plan)

    def test_bundle_migration_inventory_must_match_approved_order_before_mutation(self):
        mismatched = json.loads(json.dumps(self.plan))
        mismatched["migrations"]["pending"] = ["UnexpectedMigration1788289200000"]
        mismatched["migrations"]["postHead"] = "UnexpectedMigration1788289200000"
        with self.assertRaisesRegex(deploy.StopBeforeMutation, "MIGRATION_SET_MISMATCH"):
            deploy.validate_bundle_pair(self.current, self.rollback, mismatched)

    def test_wrong_host_and_bad_bundle_fail_closed(self):
        wrong = json.loads(json.dumps(self.plan))
        wrong["host"]["hostname"] = "other"
        with self.assertRaisesRegex(deploy.StopBeforeMutation, "UNAPPROVED_HOST"):
            deploy.validate_plan(wrong)
        (self.current / "compose.production.yml").write_text("tampered", encoding="utf-8")
        with self.assertRaisesRegex(deploy.StopBeforeMutation, "HASH_MISMATCH"):
            deploy.validate_bundle_pair(self.current, self.rollback, self.plan)

    def test_deterministic_archive_and_safe_extraction(self):
        manifest, _ = deploy.validate_bundle_pair(self.current, self.rollback, self.plan)
        first, second = self.root / "first.tar", self.root / "second.tar"
        self.assertEqual(
            deploy.deterministic_archive(self.current, manifest, first),
            deploy.deterministic_archive(self.current, manifest, second),
        )
        allowed = {"release-manifest.json"} | {entry["path"] for entry in manifest["artifacts"]}
        deploy.safe_extract(first, self.root / "extracted", allowed)
        self.assertEqual(deploy.sha256_file(first), deploy.sha256_file(second))

    def test_prepare_envelope_materializes_only_verified_files(self):
        prepared = self.root / "prepared"
        args = types.SimpleNamespace(
            plan=self.plan_path, approved_plan_sha=self.sha,
            current_bundle=self.current, rollback_bundle=self.rollback,
            evidence=self.evidence_path, output_dir=prepared,
            transfer=False, from_transport=None,
        )
        self.assertEqual(deploy.prepare_command(args), 0)
        current, rollback = deploy.materialize_transport(
            prepared, self.root / "materialized", self.plan, self.sha,
        )
        deploy.validate_bundle_pair(current, rollback, self.plan)
        (prepared / "current.tar").write_bytes(b"tampered")
        with self.assertRaisesRegex(deploy.StopBeforeMutation, "TRANSFER_HASH_MISMATCH"):
            deploy.materialize_transport(prepared, self.root / "rejected", self.plan, self.sha)

    def test_archive_rejects_traversal_symlink_and_extra_file(self):
        cases = [("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("extra", tarfile.REGTYPE)]
        for index, (name, kind) in enumerate(cases):
            archive_path = self.root / f"unsafe-{index}.tar"
            with tarfile.open(archive_path, "w") as archive:
                info = tarfile.TarInfo(name)
                info.type = kind
                if kind == tarfile.SYMTYPE:
                    info.linkname = "/etc/passwd"
                    archive.addfile(info)
                else:
                    info.size = 1
                    archive.addfile(info, io.BytesIO(b"x"))
            with self.assertRaises(deploy.StopBeforeMutation):
                deploy.safe_extract(archive_path, self.root / f"bad-{index}", {"allowed"})

    def test_preflight_adversarial_matrix(self):
        runtime = FakeRuntime(self.plan)
        baseline = dict(runtime.snapshot(self.plan, Path("/opt/genesis/release")))
        mutations = {
            "hostname": "wrong", "apiImage": CANDIDATE_IMAGE, "activeFingerprint": self.plan["candidate"]["bundleFingerprint"],
            "migrations": ["unexpected"], "secretsValid": False, "volume": "wrong", "freeBytes": 0,
            "unexpectedStaging": ["stale"], "lockHeld": True, "postgresHealth": "unhealthy",
        }
        for key, value in mutations.items():
            observed = dict(baseline)
            observed[key] = value
            with self.subTest(key=key), self.assertRaises((deploy.StopBeforeMutation, deploy.EscalationRequired)):
                deploy.validate_snapshot(self.plan, observed)
        stale_rollback = dict(baseline)
        stale_rollback["rollbackReady"] = True
        with self.assertRaisesRegex(deploy.StopBeforeMutation, "UNEXPECTED_ROLLBACK_STAGING"):
            deploy.validate_snapshot(self.plan, stale_rollback)

    def test_repeated_preflight_is_read_only(self):
        runtime = FakeRuntime(self.plan)
        self.assertEqual(deploy.preflight(self.plan, self.current, self.rollback, runtime, self.evidence()), "READY")
        self.assertEqual(deploy.preflight(self.plan, self.current, self.rollback, runtime, self.evidence()), "READY")
        self.assertEqual(runtime.mutations, [])

    def test_every_authorization_negative_has_zero_mutation(self):
        cases = [
            (False, {"GENESIS_PRODUCTION_MUTATION_AUTHORIZED": "true"}, self.plan["authorizationId"], self.sha),
            (True, {}, self.plan["authorizationId"], self.sha),
            (True, {"GENESIS_PRODUCTION_MUTATION_AUTHORIZED": "true"}, "AUTH:wrong:001", self.sha),
            (True, {"GENESIS_PRODUCTION_MUTATION_AUTHORIZED": "true"}, self.plan["authorizationId"], "0" * 64),
        ]
        for flag, env, authorization, approved_sha in cases:
            runtime = FakeRuntime(self.plan)
            with self.subTest(flag=flag, env=env, authorization=authorization), self.assertRaises(deploy.StopBeforeMutation):
                deploy.execute(
                    self.plan, self.current, self.rollback, runtime, self.evidence(), self.sha,
                    flag=flag, environment=env, authorization_id=authorization,
                    approved_plan_sha=approved_sha, lock_factory=fake_lock,
                )
            self.assertEqual(runtime.mutations, [])

    def execute_success(self, runtime=None, lock_factory=fake_lock):
        runtime = runtime or FakeRuntime(self.plan)
        clock = FakeClock()
        result = deploy.execute(
            self.plan, self.current, self.rollback, runtime, self.evidence(), self.sha,
            flag=True, environment={"GENESIS_PRODUCTION_MUTATION_AUTHORIZED": "true"},
            authorization_id=self.plan["authorizationId"], approved_plan_sha=self.sha,
            lock_factory=lock_factory, monotonic=clock.monotonic, sleep=clock.sleep,
        )
        return result, runtime, clock

    def test_success_orders_mutation_and_observes_exact_window(self):
        result, runtime, clock = self.execute_success()
        self.assertEqual(result, "CANDIDATE_OBSERVED / READY_FOR_KEEP")
        self.assertEqual(runtime.mutations, ["pull", "migration", "activation", "api-recreate"])
        self.assertEqual(clock.sleeps, [120.0, 180.0, 300.0, 300.0])
        self.assertEqual(runtime.observe_calls, 5)
        lines = [json.loads(line) for line in self.evidence_path.read_text().splitlines()]
        phases = [(line["phase"], line["result"]) for line in lines]
        self.assertLess(phases.index(("preflight", "PRE_MUTATION_READY")), phases.index(("authorization", "MUTATION_AUTHORIZED")))
        self.assertEqual(lines[-1]["state"], "READY_FOR_KEEP")
        self.assertNotIn(("execute", "KEEP"), phases)

    @unittest.skipIf(deploy.fcntl is None, "requires Linux flock semantics")
    def test_execute_distinguishes_its_owned_flock_from_external_lock(self):
        runtime = FakeRuntime(self.plan)
        lock_path = self.root / "deployment.lock"
        self.plan["paths"]["deploymentLock"] = str(lock_path)
        original_snapshot = runtime.snapshot

        def lock_reporting_snapshot(plan, release_root):
            observed = original_snapshot(plan, release_root)
            observed["lockHeld"] = deploy.SystemRuntime._lock_is_held(lock_path)
            return observed

        runtime.snapshot = lock_reporting_snapshot
        result, _, _ = self.execute_success(runtime, lock_factory=deploy.deployment_lock)
        self.assertEqual(result, "CANDIDATE_OBSERVED / READY_FOR_KEEP")
        self.assertEqual(runtime.observe_calls, 5)
        self.assertFalse(deploy.SystemRuntime._lock_is_held(lock_path))

    def test_migration_failure_prevents_activation_and_db_revert(self):
        runtime = FakeRuntime(self.plan)
        runtime.fail_at = "migration"
        with self.assertRaises(deploy.StopBeforeMutation):
            self.execute_success(runtime)
        self.assertEqual(runtime.mutations, ["pull", "migration"])
        self.assertNotIn("activation", runtime.mutations)
        self.assertNotIn("migration-revert", runtime.mutations)

    def test_candidate_failure_rolls_back_application_and_preserves_schema(self):
        runtime = FakeRuntime(self.plan)
        runtime.fail_at = "smoke"
        with self.assertRaisesRegex(deploy.EscalationRequired, "NO_AUTOMATIC_RETRY"):
            self.execute_success(runtime)
        self.assertEqual(runtime.state, "rollback-after")
        self.assertEqual(runtime.mutations.count("rollback"), 1)
        self.assertNotIn("migration-revert", runtime.mutations)

    def test_observation_rejects_candidate_regression_to_healthy_baseline(self):
        runtime = FakeRuntime(self.plan)
        runtime.fail_at = "candidate-regression"
        with self.assertRaisesRegex(deploy.EscalationRequired, "NO_AUTOMATIC_RETRY"):
            self.execute_success(runtime)
        self.assertEqual(runtime.state, "rollback-after")
        self.assertEqual(runtime.observe_calls, 1)
        self.assertEqual(runtime.mutations.count("rollback"), 1)

    def test_rollback_failure_escalates(self):
        runtime = FakeRuntime(self.plan)
        runtime.fail_at = "observation"
        original_rollback = runtime.rollback
        def failing_rollback(plan):
            original_rollback(plan)
            raise deploy.StopBeforeMutation("ROLLBACK_FAILED")
        runtime.rollback = failing_rollback
        with self.assertRaisesRegex(deploy.EscalationRequired, "ROLLBACK_FAILED"):
            self.execute_success(runtime)

    def test_already_active_is_noop_and_old_app_new_schema_escalates(self):
        runtime = FakeRuntime(self.plan)
        runtime.state = "candidate"
        result, runtime, _ = self.execute_success(runtime)
        self.assertEqual(result, "ALREADY_ACTIVE")
        self.assertEqual(runtime.mutations, [])
        runtime.state = "migrated"
        with self.assertRaisesRegex(deploy.EscalationRequired, "MIGRATIONS_APPLIED_WITH_OLD_APPLICATION"):
            deploy.preflight(self.plan, self.current, self.rollback, runtime, self.evidence())

    def test_evidence_rejects_sensitive_fields_and_contains_no_payloads(self):
        evidence = self.evidence()
        with self.assertRaisesRegex(deploy.StopBeforeMutation, "UNSAFE_EVIDENCE_FIELD"):
            evidence.emit("test", "FAIL", password="should-not-appear")
        evidence.emit("test", "PASS", reasonCode="SAFE_CODE")
        text = self.evidence_path.read_text(encoding="utf-8").lower()
        for forbidden in ("should-not-appear", "cookie", "bearer", "set-cookie"):
            self.assertNotIn(forbidden, text)

    def test_ssh_contract_is_batch_strict_and_checks_pinned_fingerprint(self):
        known_hosts = self.root / "known_hosts"
        identity = self.root / "id_ed25519"
        known_hosts.write_text("fixture", encoding="utf-8")
        identity.write_text("fixture", encoding="utf-8")
        os.chmod(identity, 0o600)
        ssh_plan = json.loads(json.dumps(self.plan))
        ssh_plan["host"]["knownHostsFile"] = str(known_hosts)
        ssh_plan["host"]["identityFile"] = str(identity)
        calls = []
        def fake_run(argv, **kwargs):
            calls.append(argv)
            if "-F" in argv:
                return types.SimpleNamespace(returncode=0, stdout="fixture-key\n")
            return types.SimpleNamespace(returncode=0, stdout=f"256 {ssh_plan['host']['hostKeyFingerprint']} fixture\n")
        deploy.validate_ssh_host_key(ssh_plan, run=fake_run)
        base = deploy.ssh_base(ssh_plan)
        self.assertIn("BatchMode=yes", base)
        self.assertIn("StrictHostKeyChecking=yes", base)
        self.assertEqual(len(calls), 2)

    @unittest.skipIf(os.name == "nt", "root-only /run cleanup contract executes in Linux CI")
    def test_registry_credentials_use_stdin_and_temporary_config_is_removed(self):
        credentials = self.root / "registry.json"
        credentials.write_text(json.dumps({"username": "fixture-user", "password": "fixture-password"}), encoding="utf-8")
        registry_plan = json.loads(json.dumps(self.plan))
        next(secret for secret in registry_plan["secrets"] if secret["purpose"] == "registry")["path"] = str(credentials)
        calls, config_paths = [], []
        original = deploy.SystemRuntime.__dict__["_run"]

        def fake_run(argv, *, input_text=None, timeout=120):
            calls.append((list(argv), input_text))
            if "--config" in argv:
                config_paths.append(Path(argv[argv.index("--config") + 1]))
            if argv[1:3] == ["image", "inspect"]:
                image = argv[-1]
                return json.dumps([{"Os": "linux", "Architecture": "amd64", "RepoDigests": [image]}])
            return ""

        deploy.SystemRuntime._run = staticmethod(fake_run)
        try:
            deploy.SystemRuntime().registry_pull(registry_plan)
        finally:
            deploy.SystemRuntime._run = original
        self.assertTrue(config_paths)
        self.assertTrue(all(not path.exists() for path in config_paths))
        self.assertTrue(any(input_text == "fixture-password\n" for _, input_text in calls))
        self.assertTrue(all("fixture-password" not in argv for argv, _ in calls))

    def test_kanban_protocol_accepts_generic_financial_contract(self):
        deploy.validate_kanban({
            "currency": "BRL", "expectedValueTotalMinor": "1000", "withoutExpectedValue": 1,
            "columns": [{"expectedValueTotalMinor": "1000", "withoutExpectedValue": 1,
                         "items": [{"expectedValueMinor": None}, {"expectedValueMinor": "1000"}]}],
        })
        with self.assertRaisesRegex(deploy.StopBeforeMutation, "KANBAN_PROTOCOL"):
            deploy.validate_kanban({"currency": "USD"})
        with self.assertRaisesRegex(deploy.StopBeforeMutation, "KANBAN_PROTOCOL"):
            deploy.validate_kanban({
                "currency": "BRL", "expectedValueTotalMinor": "1000", "withoutExpectedValue": 1,
                "columns": [{"expectedValueTotalMinor": "1000", "withoutExpectedValue": 1,
                             "items": [{"expectedValueMinor": 1000}]}],
            })


if __name__ == "__main__":
    unittest.main(verbosity=2)
