const { createHash } = require('node:crypto');

const PROVENANCE_LABELS = new Set([
  'org.opencontainers.image.revision',
  'org.opencontainers.image.created',
  'org.opencontainers.image.version',
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function packagePurl(entry) {
  return (
    entry.externalRefs?.find(
      (reference) =>
        reference.referenceCategory === 'PACKAGE-MANAGER' &&
        reference.referenceType === 'purl',
    )?.referenceLocator ?? ''
  );
}

function isImageDocumentPackage(entry) {
  return (
    entry?.primaryPackagePurpose === 'CONTAINER' &&
    /^pkg:oci\//u.test(packagePurl(entry))
  );
}

function functionalPackageInventory(sbom) {
  if (!Array.isArray(sbom?.packages)) {
    throw new Error('SBOM packages are absent.');
  }
  return sbom.packages
    .filter((entry) => !isImageDocumentPackage(entry))
    .map((entry) => {
      const purl = packagePurl(entry);
      const type = /^pkg:([^/]+)/u.exec(purl)?.[1] ?? 'unknown';
      return {
        name: entry.name ?? '',
        type,
        version: entry.versionInfo ?? '',
        purl,
      };
    })
    .sort((left, right) =>
      stableStringify(left).localeCompare(stableStringify(right)),
    );
}

function functionalLabels(labels = {}) {
  return Object.fromEntries(
    Object.entries(labels ?? {})
      .filter(([name]) => !PROVENANCE_LABELS.has(name))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function runtimeFunctionalConfig(config = {}) {
  return {
    user: config.User ?? '',
    entrypoint: config.Entrypoint ?? [],
    command: config.Cmd ?? [],
    workingDirectory: config.WorkingDir ?? '',
    environment: [...(config.Env ?? [])].sort(),
    functionalLabels: functionalLabels(config.Labels),
    healthcheck: config.Healthcheck ?? null,
    stopSignal: config.StopSignal ?? '',
    exposedPorts: Object.keys(config.ExposedPorts ?? {}).sort(),
    volumes: Object.keys(config.Volumes ?? {}).sort(),
    shell: config.Shell ?? [],
    argsEscaped: config.ArgsEscaped ?? false,
  };
}

function validateRuntimeFilesystemEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('runtime filesystem entry must be an object.');
  }
  if (
    typeof entry.path !== 'string' ||
    entry.path.length === 0 ||
    entry.path.startsWith('/') ||
    entry.path.includes('..')
  ) {
    throw new Error(`runtime filesystem path is invalid: ${entry.path}`);
  }
  if (!['file', 'directory', 'symlink'].includes(entry.type)) {
    throw new Error(`runtime filesystem type is invalid: ${entry.type}`);
  }
  for (const name of ['mode', 'uid', 'gid', 'size']) {
    if (!Number.isInteger(entry[name]) || entry[name] < 0) {
      throw new Error(`runtime filesystem ${name} is invalid: ${entry.path}`);
    }
  }
  if (entry.type === 'file' && !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')) {
    throw new Error(`runtime file hash is invalid: ${entry.path}`);
  }
  if (
    entry.type === 'symlink' &&
    (typeof entry.target !== 'string' || entry.target.length === 0)
  ) {
    throw new Error(`runtime symlink target is invalid: ${entry.path}`);
  }
}

function calculateRuntimeFilesystemContent(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('runtime filesystem entries are absent.');
  }
  entries.forEach(validateRuntimeFilesystemEntry);
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error('runtime filesystem paths must be unique.');
  }
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    schemaVersion: 'runtime-filesystem-content.v1',
    roots: ['/app/dist', '/app/node_modules', '/app/package.json'],
    entries: sorted,
    entryCount: sorted.length,
    id: `sha256:${sha256(stableStringify(sorted))}`,
  };
}

function normalizeRuntimeFilesystem(runtimeFilesystem) {
  if (Array.isArray(runtimeFilesystem)) {
    return calculateRuntimeFilesystemContent(runtimeFilesystem);
  }
  if (Array.isArray(runtimeFilesystem?.entries)) {
    const calculated = calculateRuntimeFilesystemContent(
      runtimeFilesystem.entries,
    );
    if (runtimeFilesystem.id && runtimeFilesystem.id !== calculated.id) {
      throw new Error('runtime filesystem content ID does not match entries.');
    }
    return calculated;
  }
  if (
    runtimeFilesystem?.schemaVersion === 'runtime-filesystem-content.v1' &&
    /^sha256:[a-f0-9]{64}$/u.test(runtimeFilesystem.id ?? '') &&
    Number.isInteger(runtimeFilesystem.entryCount) &&
    runtimeFilesystem.entryCount > 0
  ) {
    return runtimeFilesystem;
  }
  throw new Error('runtime filesystem evidence is invalid.');
}

function packageVersion(packages, name) {
  const versions = [
    ...new Set(
      packages
        .filter((entry) => entry.name === name)
        .map((entry) => entry.version),
    ),
  ];
  if (versions.length !== 1) {
    throw new Error(`${name} package identity is not unique.`);
  }
  return versions[0];
}

function assertInspect(imageInspect) {
  if (
    !imageInspect?.Config ||
    !Array.isArray(imageInspect?.RootFS?.Layers) ||
    imageInspect.RootFS.Layers.length === 0
  ) {
    throw new Error('Docker image inspect data is incomplete.');
  }
}

function calculateRuntimeSecuritySubjectV1({ imageInspect, sbom, baseDigest }) {
  assertInspect(imageInspect);
  const packages = functionalPackageInventory(sbom);
  const subject = {
    schemaVersion: 'runtime-security-subject.v1',
    baseManifestDigest: baseDigest,
    platform: `${imageInspect.Os}/${imageInspect.Architecture}`,
    rootfsDiffIds: [...imageInspect.RootFS.Layers],
    packages,
    nodeVersion: packageVersion(packages, 'node'),
    libc6Version: packageVersion(packages, 'libc6'),
    runtime: runtimeFunctionalConfig(imageInspect.Config),
  };
  return {
    id: `sha256:${sha256(stableStringify(subject))}`,
    subject,
  };
}

function calculateRuntimeSecuritySubjectV2({
  imageInspect,
  sbom,
  baseDigest,
  runtimeFilesystem,
}) {
  assertInspect(imageInspect);
  const filesystem = normalizeRuntimeFilesystem(runtimeFilesystem);
  const packages = functionalPackageInventory(sbom);
  const subject = {
    schemaVersion: 'runtime-security-subject.v2',
    baseManifestDigest: baseDigest,
    platform: `${imageInspect.Os}/${imageInspect.Architecture}`,
    runtimeFilesystemContentId: filesystem.id,
    functionalPackageInventory: packages,
    nodeVersion: packageVersion(packages, 'node'),
    libc6Version: packageVersion(packages, 'libc6'),
    runtimeFunctionalConfig: runtimeFunctionalConfig(imageInspect.Config),
  };
  return {
    id: `sha256:${sha256(stableStringify(subject))}`,
    subject,
    runtimeFilesystem: filesystem,
  };
}

function imageInspectFromGrypeSource(scan) {
  const target = scan?.source?.target;
  if (!target?.config) throw new Error('Grype source image config is absent.');
  const configDocument = JSON.parse(
    Buffer.from(target.config, 'base64').toString('utf8'),
  );
  return {
    Id: target.imageID,
    Os: configDocument.os,
    Architecture: configDocument.architecture,
    RootFS: { Layers: configDocument.rootfs?.diff_ids },
    Config: configDocument.config,
  };
}

function subjectComponentDiff(expected, actual) {
  const fields = [
    'baseManifestDigest',
    'platform',
    'runtimeFilesystemContentId',
    'functionalPackageInventory',
    'nodeVersion',
    'libc6Version',
    'runtimeFunctionalConfig',
  ];
  return fields
    .map((field) => ({
      field,
      expectedHash: sha256(stableStringify(expected?.[field] ?? null)),
      actualHash: sha256(stableStringify(actual?.[field] ?? null)),
      equivalent:
        stableStringify(expected?.[field] ?? null) ===
        stableStringify(actual?.[field] ?? null),
    }))
    .filter((entry) => !entry.equivalent);
}

function runtimeFilesystemProbeSource() {
  return `
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const roots = ['/app/dist', '/app/node_modules', '/app/package.json'];
const entries = [];
function visit(absolute) {
  const stat = fs.lstatSync(absolute);
  const relative = path.posix.relative('/app', absolute);
  const base = { path: relative, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
  if (stat.isSymbolicLink()) {
    entries.push({ ...base, type: 'symlink', size: 0, target: fs.readlinkSync(absolute) });
    return;
  }
  if (stat.isDirectory()) {
    entries.push({ ...base, type: 'directory', size: 0 });
    for (const name of fs.readdirSync(absolute).sort()) visit(path.posix.join(absolute, name));
    return;
  }
  if (stat.isFile()) {
    const content = fs.readFileSync(absolute);
    entries.push({ ...base, type: 'file', size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
    return;
  }
  throw new Error('unsupported runtime entry: ' + absolute);
}
for (const root of roots) visit(root);
process.stdout.write(JSON.stringify(entries));
`.trim();
}

module.exports = {
  PROVENANCE_LABELS,
  calculateRuntimeFilesystemContent,
  calculateRuntimeSecuritySubjectV1,
  calculateRuntimeSecuritySubjectV2,
  canonicalize,
  functionalLabels,
  functionalPackageInventory,
  imageInspectFromGrypeSource,
  isImageDocumentPackage,
  normalizeRuntimeFilesystem,
  runtimeFilesystemProbeSource,
  runtimeFunctionalConfig,
  sha256,
  stableStringify,
  subjectComponentDiff,
};
