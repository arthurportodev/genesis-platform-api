const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateRuntimeFilesystemContent,
  calculateRuntimeSecuritySubjectV1,
  calculateRuntimeSecuritySubjectV2,
  functionalPackageInventory,
} = require('../../scripts/runtime-security-subject.cjs');

const BASE_DIGEST = `sha256:${'b'.repeat(64)}`;

function packageEntry(name, version, purl, extra = {}) {
  return {
    SPDXID: `SPDXRef-${name}`,
    name,
    versionInfo: version,
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: purl,
      },
    ],
    ...extra,
  };
}

function fixture() {
  return {
    imageInspect: {
      Id: `sha256:${'a'.repeat(64)}`,
      Os: 'linux',
      Architecture: 'amd64',
      RootFS: { Layers: [`sha256:${'1'.repeat(64)}`] },
      Config: {
        User: '65532',
        Entrypoint: ['/nodejs/bin/node'],
        Cmd: ['dist/main.js'],
        WorkingDir: '/app',
        Env: ['NODE_ENV=production'],
        Labels: {
          service: 'api',
          'org.opencontainers.image.revision': 'first-builder',
        },
      },
    },
    sbom: {
      packages: [
        packageEntry('node', '24.18.0', 'pkg:generic/node@24.18.0'),
        packageEntry(
          'libc6',
          '2.41-12+deb13u3',
          'pkg:deb/debian/libc6@2.41-12%2Bdeb13u3',
        ),
        packageEntry('api', '0.1.0', 'pkg:npm/api@0.1.0'),
        packageEntry(
          'image-document',
          'latest',
          'pkg:oci/genesis-platform-api@sha256%3Adeadbeef',
          { primaryPackagePurpose: 'CONTAINER' },
        ),
      ],
    },
    runtimeFilesystem: calculateRuntimeFilesystemContent([
      {
        path: 'dist',
        type: 'directory',
        mode: 493,
        uid: 65532,
        gid: 65532,
        size: 0,
      },
      {
        path: 'dist/main.js',
        type: 'file',
        mode: 420,
        uid: 65532,
        gid: 65532,
        size: 3,
        sha256: '2'.repeat(64),
      },
    ]),
  };
}

function subjectV2(input, baseDigest = BASE_DIGEST) {
  return calculateRuntimeSecuritySubjectV2({
    ...input,
    baseDigest,
  }).id;
}

function replaceFilesystemEntry(input, index, changes) {
  input.runtimeFilesystem = calculateRuntimeFilesystemContent(
    input.runtimeFilesystem.entries.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, ...changes } : entry,
    ),
  );
}

test('subject v2 is portable across physical layers and approved provenance labels', () => {
  const input = fixture();
  const original = subjectV2(input);
  input.imageInspect.RootFS.Layers = [
    `sha256:${'3'.repeat(64)}`,
    `sha256:${'4'.repeat(64)}`,
  ];
  input.imageInspect.Config.Labels['org.opencontainers.image.revision'] =
    'second-builder';
  input.imageInspect.Config.Labels['org.opencontainers.image.created'] =
    '2026-07-31T12:00:00Z';
  input.imageInspect.Config.Labels['org.opencontainers.image.version'] =
    '0.1.1-build-only';
  assert.equal(subjectV2(input), original);
});

test('subject v2 ignores build-instance identity and checkout metadata', () => {
  const original = fixture();
  const rebuilt = fixture();
  rebuilt.imageInspect.Id = `sha256:${'b'.repeat(64)}`;
  rebuilt.imageInspect.RepoTags = ['genesis-platform-api:other-local-tag'];
  rebuilt.imageInspect.Created = '2026-07-31T12:00:00Z';
  rebuilt.imageInspect.Descriptor = `sha256:${'c'.repeat(64)}`;
  rebuilt.imageInspect.RuntimeManifest = `sha256:${'d'.repeat(64)}`;
  rebuilt.imageInspect.BuildKitCache = 'isolated-builder-b';
  rebuilt.imageInspect.CheckoutTimestamp = '2026-07-31T12:00:00Z';
  rebuilt.imageInspect.RootFS.Layers = [
    `sha256:${'e'.repeat(64)}`,
    `sha256:${'f'.repeat(64)}`,
  ];
  assert.equal(subjectV2(rebuilt), subjectV2(original));
});

test('known merge and head provenance with equivalent trees keeps subject v2 stable', () => {
  const mergeSha = 'abdbc9819705e30e3487304b3b635b1740f74932';
  const headSha = 'c87f0a6a07493ba30bacb2c73706c618f6666f92';
  const mergeTree = '207738ce52a8d6047b2a90e3d36e58bb4ba947c5';
  const headTree = '207738ce52a8d6047b2a90e3d36e58bb4ba947c5';
  assert.notEqual(mergeSha, headSha);
  assert.equal(mergeTree, headTree);

  const mergeBuild = fixture();
  mergeBuild.imageInspect.Config.Labels['org.opencontainers.image.revision'] =
    mergeSha;
  mergeBuild.imageInspect.RootFS.Layers = [`sha256:${'7'.repeat(64)}`];
  const headBuild = fixture();
  headBuild.imageInspect.Config.Labels['org.opencontainers.image.revision'] =
    headSha;
  headBuild.imageInspect.RootFS.Layers = [`sha256:${'8'.repeat(64)}`];
  assert.equal(subjectV2(mergeBuild), subjectV2(headBuild));
});

test('subject v1 remains sensitive to physical layer identity', () => {
  const input = fixture();
  const original = calculateRuntimeSecuritySubjectV1({
    imageInspect: input.imageInspect,
    sbom: input.sbom,
    baseDigest: BASE_DIGEST,
  }).id;
  input.imageInspect.RootFS.Layers.push(`sha256:${'5'.repeat(64)}`);
  assert.notEqual(
    calculateRuntimeSecuritySubjectV1({
      imageInspect: input.imageInspect,
      sbom: input.sbom,
      baseDigest: BASE_DIGEST,
    }).id,
    original,
  );
});

test('subject v2 changes for filesystem, package, or functional config drift', () => {
  const input = fixture();
  const original = subjectV2(input);

  const filesystemDrift = fixture();
  filesystemDrift.runtimeFilesystem.entries[1].sha256 = '6'.repeat(64);
  filesystemDrift.runtimeFilesystem.id = undefined;
  assert.notEqual(subjectV2(filesystemDrift), original);

  const packageDrift = fixture();
  packageDrift.sbom.packages.push(
    packageEntry('native-addon', '1.0.0', 'pkg:npm/native-addon@1.0.0'),
  );
  assert.notEqual(subjectV2(packageDrift), original);

  const configDrift = fixture();
  configDrift.imageInspect.Config.Env.push('FEATURE=true');
  assert.notEqual(subjectV2(configDrift), original);
});

test('subject v2 changes when one application file byte changes', () => {
  const original = fixture();
  const changed = fixture();
  replaceFilesystemEntry(changed, 1, { sha256: '3'.repeat(64) });
  assert.notEqual(subjectV2(changed), subjectV2(original));
});

test('subject v2 changes when a package is removed', () => {
  const original = fixture();
  const changed = fixture();
  changed.sbom.packages = changed.sbom.packages.filter(
    (entry) => entry.name !== 'api',
  );
  assert.notEqual(subjectV2(changed), subjectV2(original));
});

test('subject v2 changes when a package version changes', () => {
  const original = fixture();
  const changed = fixture();
  const api = changed.sbom.packages.find((entry) => entry.name === 'api');
  api.versionInfo = '0.2.0';
  api.externalRefs[0].referenceLocator = 'pkg:npm/api@0.2.0';
  assert.notEqual(subjectV2(changed), subjectV2(original));
});

test('subject v2 changes when a native addon changes', () => {
  const original = fixture();
  const changed = fixture();
  changed.sbom.packages.push(
    packageEntry('native-addon', '2.0.0', 'pkg:npm/native-addon@2.0.0'),
  );
  changed.runtimeFilesystem = calculateRuntimeFilesystemContent([
    ...changed.runtimeFilesystem.entries,
    {
      path: 'node_modules/native-addon/addon.node',
      type: 'file',
      mode: 493,
      uid: 65532,
      gid: 65532,
      size: 64,
      sha256: '4'.repeat(64),
    },
  ]);
  assert.notEqual(subjectV2(changed), subjectV2(original));
});

test('subject v2 changes when a symlink target changes', () => {
  const left = fixture();
  left.runtimeFilesystem = calculateRuntimeFilesystemContent([
    ...left.runtimeFilesystem.entries,
    {
      path: 'node_modules/.bin/api',
      type: 'symlink',
      mode: 511,
      uid: 65532,
      gid: 65532,
      size: 0,
      target: '../api/bin/a.js',
    },
  ]);
  const right = structuredClone(left);
  right.runtimeFilesystem.entries.at(-1).target = '../api/bin/b.js';
  right.runtimeFilesystem.id = undefined;
  assert.notEqual(subjectV2(right), subjectV2(left));
});

test('subject v2 changes for mode, UID, or GID drift', () => {
  const original = fixture();
  for (const changes of [{ mode: 493 }, { uid: 0 }, { gid: 0 }]) {
    const changed = fixture();
    replaceFilesystemEntry(changed, 1, changes);
    assert.notEqual(subjectV2(changed), subjectV2(original));
  }
});

test('subject v2 changes for base digest or architecture drift', () => {
  const original = fixture();
  assert.notEqual(
    subjectV2(fixture(), `sha256:${'c'.repeat(64)}`),
    subjectV2(original),
  );
  const architecture = fixture();
  architecture.imageInspect.Architecture = 'arm64';
  assert.notEqual(subjectV2(architecture), subjectV2(original));
});

test('subject v2 changes for Node or libc6 version drift', () => {
  const original = fixture();
  for (const [name, version] of [
    ['node', '24.18.1'],
    ['libc6', '2.41-13'],
  ]) {
    const changed = fixture();
    const entry = changed.sbom.packages.find((item) => item.name === name);
    entry.versionInfo = version;
    entry.externalRefs[0].referenceLocator = `pkg:generic/${name}@${version}`;
    assert.notEqual(subjectV2(changed), subjectV2(original));
  }
});

test('subject v2 changes for command, healthcheck, or functional label drift', () => {
  const original = fixture();

  const command = fixture();
  command.imageInspect.Config.Cmd = ['dist/worker.js'];
  assert.notEqual(subjectV2(command), subjectV2(original));

  const healthcheck = fixture();
  healthcheck.imageInspect.Config.Healthcheck = {
    Test: ['CMD', '/nodejs/bin/node', 'health.js'],
    Interval: 30_000_000_000,
  };
  assert.notEqual(subjectV2(healthcheck), subjectV2(original));

  const label = fixture();
  label.imageInspect.Config.Labels.service = 'other-api';
  assert.notEqual(subjectV2(label), subjectV2(original));
});

test('filesystem identity is deterministic by canonical path order', () => {
  const input = fixture().runtimeFilesystem.entries;
  assert.equal(
    calculateRuntimeFilesystemContent([...input].reverse()).id,
    calculateRuntimeFilesystemContent(input).id,
  );
});

test('rejects a runtime filesystem manifest whose declared ID is stale', () => {
  const input = fixture();
  input.runtimeFilesystem.entries[1].sha256 = '9'.repeat(64);
  assert.throws(
    () => subjectV2(input),
    /runtime filesystem content ID does not match entries/u,
  );
});

test('changes subject v2 when the canonical filesystem content ID changes', () => {
  const original = fixture();
  const changed = fixture();
  changed.runtimeFilesystem = calculateRuntimeFilesystemContent([
    ...changed.runtimeFilesystem.entries.slice(0, 1),
    {
      ...changed.runtimeFilesystem.entries[1],
      sha256: 'a'.repeat(64),
    },
  ]);
  assert.notEqual(subjectV2(changed), subjectV2(original));
});

test('SBOM exclusion is closed to packages explicitly typed as OCI containers', () => {
  const input = fixture();
  const inventory = functionalPackageInventory(input.sbom);
  assert.equal(
    inventory.some((entry) => entry.name === 'image-document'),
    false,
  );
  input.sbom.packages.push(
    packageEntry('lookalike', '1.0.0', 'pkg:npm/lookalike@1.0.0', {
      primaryPackagePurpose: 'CONTAINER',
    }),
  );
  assert.equal(
    functionalPackageInventory(input.sbom).some(
      (entry) => entry.name === 'lookalike',
    ),
    true,
  );
});
