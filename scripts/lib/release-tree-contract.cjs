const BUNDLE_CONTRACT_VERSION = '0.8-MVP-08.v2';
const RELEASE_TREE_CONTRACT_VERSION = '0.8-MVP-08.release-tree.v1';

const RELEASE_DIRECTORIES = [
  '.',
  'config',
  'config/recovery',
  'docker',
  'docker/postgres',
  'docker/production',
  'docker/recovery',
  'docker/recovery/systemd',
  'docker/traefik',
  'docker/traefik/dynamic',
  'docs',
].map((path) => ({
  path,
  type: 'directory',
  owner: 0,
  group: 0,
  mode: '0755',
}));

const RELEASE_MANIFEST_ENTRY = {
  path: 'release-manifest.json',
  type: 'file',
  owner: 0,
  group: 0,
  mode: '0644',
};

const RELEASE_TREE = {
  contractVersion: RELEASE_TREE_CONTRACT_VERSION,
  parent: {
    path: '/opt/genesis',
    type: 'directory',
    owner: 0,
    group: 0,
    mode: '0755',
  },
  active: {
    path: '/opt/genesis/release',
  },
  construction: {
    stagingNamePrefix: '.genesis-release-staging-',
    initialOwner: 0,
    initialGroup: 0,
    initialMode: '0700',
    sourcePolicy: 'canonical-bundle-only',
  },
  rollback: {
    siblingNamePrefix: '.genesis-release-rollback-',
    sourcePolicy: 'derived-previous-approved-image-committed-release-only',
    writableByGroupOrOther: false,
  },
  quarantine: {
    marker: '.genesis-untrusted-release.json',
    owner: 0,
    group: 0,
    mode: '0700',
    deleteAutomatically: false,
    eligibleForRollback: false,
  },
  lock: {
    path: '/run/lock/genesis-release-tree.lock',
    owner: 0,
    group: 0,
    mode: '0600',
  },
  activation: {
    primitive: 'renameat2',
    flag: 'RENAME_EXCHANGE',
    requireSameDevice: true,
    nonAtomicFallback: 'forbidden',
  },
  preservedExternalPaths: [
    '/opt/genesis/recovery',
    '/opt/genesis/secrets',
    '/opt/genesis/traefik-state',
    '/var/lib/docker',
    '/var/lib/genesis/recovery',
  ],
};

module.exports = {
  BUNDLE_CONTRACT_VERSION,
  RELEASE_DIRECTORIES,
  RELEASE_MANIFEST_ENTRY,
  RELEASE_TREE,
  RELEASE_TREE_CONTRACT_VERSION,
};
