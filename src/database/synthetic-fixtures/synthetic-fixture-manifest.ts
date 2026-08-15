import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  parseSyntheticFixtureManifest,
  SyntheticFixtureError,
  SyntheticFixtureManifest,
} from './synthetic-fixture.model';

export interface SyntheticFixtureManifestStore {
  exists(): Promise<boolean>;
  load(): Promise<SyntheticFixtureManifest>;
  create(manifest: SyntheticFixtureManifest): Promise<void>;
  replace(
    expected: SyntheticFixtureManifest,
    replacement: SyntheticFixtureManifest,
  ): Promise<void>;
  removeExact(manifest: SyntheticFixtureManifest): Promise<void>;
}

export class FileSyntheticFixtureManifestStore implements SyntheticFixtureManifestStore {
  readonly path: string;
  private readonly repositoryRoot: string;

  constructor(path: string, repositoryRoot: string) {
    if (!isAbsolute(path)) {
      throw new SyntheticFixtureError(
        'INVALID_MANIFEST_PATH',
        'Manifest path must be absolute.',
      );
    }
    if (!path.toLowerCase().endsWith('.json')) {
      throw new SyntheticFixtureError(
        'INVALID_MANIFEST_PATH',
        'Manifest path must use the .json extension.',
      );
    }
    this.path = resolve(path);
    this.repositoryRoot = resolve(repositoryRoot);
  }

  async assertExternalPath(createParent = false): Promise<void> {
    const parent = dirname(this.path);
    if (createParent) await mkdir(parent, { recursive: true, mode: 0o700 });
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch (error) {
      if (!createParent && hasErrorCode(error, 'ENOENT')) {
        realParent = resolve(parent);
      } else {
        throw error;
      }
    }
    const realRepository = await realpath(this.repositoryRoot);
    const effectivePath = resolve(
      realParent,
      this.path.slice(parent.length + 1),
    );
    const relation = relative(realRepository, effectivePath);
    if (
      relation === '' ||
      (!relation.startsWith('..') && !isAbsolute(relation))
    ) {
      throw new SyntheticFixtureError(
        'MANIFEST_INSIDE_REPOSITORY',
        'Manifest must be stored outside the repository.',
      );
    }
  }

  async exists(): Promise<boolean> {
    await this.assertExternalPath();
    try {
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new SyntheticFixtureError(
          'INVALID_MANIFEST_PATH',
          'Manifest path must identify a regular file.',
        );
      }
      return true;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  async load(): Promise<SyntheticFixtureManifest> {
    if (!(await this.exists())) {
      throw new SyntheticFixtureError(
        'MANIFEST_NOT_FOUND',
        'Manifest file does not exist.',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new SyntheticFixtureError(
          'INVALID_MANIFEST',
          'Manifest is not valid JSON.',
        );
      }
      throw error;
    }
    return parseSyntheticFixtureManifest(parsed);
  }

  async create(manifest: SyntheticFixtureManifest): Promise<void> {
    await this.assertExternalPath(true);
    if (await this.exists()) {
      throw new SyntheticFixtureError(
        'MANIFEST_ALREADY_EXISTS',
        'Refusing to overwrite an existing manifest.',
      );
    }
    await this.writeAtomic(manifest, false);
  }

  async replace(
    expected: SyntheticFixtureManifest,
    replacement: SyntheticFixtureManifest,
  ): Promise<void> {
    const current = await this.load();
    if (!sameManifest(current, expected)) {
      throw new SyntheticFixtureError(
        'MANIFEST_DIVERGED',
        'Manifest changed after validation.',
      );
    }
    await this.writeAtomic(replacement, true);
  }

  async removeExact(manifest: SyntheticFixtureManifest): Promise<void> {
    try {
      const current = await this.load();
      if (sameManifest(current, manifest)) await unlink(this.path);
    } catch (error) {
      if (
        error instanceof SyntheticFixtureError &&
        error.code === 'MANIFEST_NOT_FOUND'
      ) {
        return;
      }
      throw error;
    }
  }

  private async writeAtomic(
    manifest: SyntheticFixtureManifest,
    replaceExisting: boolean,
  ): Promise<void> {
    const validated = parseSyntheticFixtureManifest(manifest);
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      if (!replaceExisting && (await this.exists())) {
        throw new SyntheticFixtureError(
          'MANIFEST_ALREADY_EXISTS',
          'Refusing to overwrite an existing manifest.',
        );
      }
      if (replaceExisting) {
        await rename(temporaryPath, this.path);
      } else {
        try {
          await link(temporaryPath, this.path);
        } catch (error) {
          if (hasErrorCode(error, 'EEXIST')) {
            throw new SyntheticFixtureError(
              'MANIFEST_ALREADY_EXISTS',
              'Refusing to overwrite an existing manifest.',
            );
          }
          throw error;
        }
        await unlink(temporaryPath);
      }
      await chmod(this.path, 0o600);
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function sameManifest(
  left: SyntheticFixtureManifest,
  right: SyntheticFixtureManifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
