import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ManifestEntry {
  readonly size: number;
  readonly mtimeMs: number;
  /** Hex SHA-256 of the file content. */
  readonly sha256: string;
}

/** What was last processed, keyed by relative POSIX path. */
export interface Manifest {
  readonly version: 1;
  readonly entries: Readonly<Record<string, ManifestEntry>>;
}

export interface ManifestDiff {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly unchanged: readonly string[];
}

export const emptyManifest = (): Manifest => ({ entries: {}, version: 1 });

const SHA256_HEX = /^[0-9a-f]{64}$/;

const isEntry = (value: unknown): value is ManifestEntry => {
  const entry = value as Partial<ManifestEntry> | null;
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.size === 'number' &&
    typeof entry.mtimeMs === 'number' &&
    typeof entry.sha256 === 'string' &&
    SHA256_HEX.test(entry.sha256)
  );
};

/** Reads a manifest; a missing file is an empty manifest. */
export const loadManifest = async (file: string): Promise<Manifest> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyManifest();
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Manifest ${file} is not valid JSON; delete it to re-ingest everything`,
      { cause: error },
    );
  }
  const manifest = (
    typeof parsed === 'object' && parsed !== null ? parsed : {}
  ) as { version?: unknown; entries?: unknown };
  if (
    manifest.version !== 1 ||
    typeof manifest.entries !== 'object' ||
    manifest.entries === null ||
    Array.isArray(manifest.entries) ||
    !Object.values(manifest.entries).every(isEntry)
  ) {
    throw new Error(
      `Manifest ${file} has an unsupported format; delete it to re-ingest everything`,
    );
  }
  return { entries: manifest.entries as Manifest['entries'], version: 1 };
};

/**
 * Writes a manifest atomically (temp file, then rename) so an interrupted run
 * can never leave a half-written file behind.
 */
export const saveManifest = async (
  file: string,
  manifest: Manifest,
): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(manifest.entries).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ entries: sorted, version: 1 }, null, 2)}\n`,
    );
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

/** Returns a copy of the manifest with `path` set to `entry`. */
export const withEntry = (
  manifest: Manifest,
  path: string,
  entry: ManifestEntry,
): Manifest => ({
  entries: { ...manifest.entries, [path]: entry },
  version: 1,
});

/** Returns a copy of the manifest without `path`. */
export const withoutEntry = (manifest: Manifest, path: string): Manifest => {
  const { [path]: _removed, ...rest } = manifest.entries;
  return { entries: rest, version: 1 };
};

/** Compares what was processed (`previous`) with what is there now. */
export const diffManifest = (
  previous: Manifest,
  current: Manifest,
): ManifestDiff => {
  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [path, entry] of Object.entries(current.entries)) {
    const before = previous.entries[path];
    if (before === undefined) {
      added.push(path);
    } else if (before.sha256 === entry.sha256) {
      unchanged.push(path);
    } else {
      changed.push(path);
    }
  }
  const removed = Object.keys(previous.entries).filter(
    (path) => current.entries[path] === undefined,
  );
  const sort = (paths: string[]): string[] => paths.sort();
  return {
    added: sort(added),
    changed: sort(changed),
    removed: sort(removed),
    unchanged: sort(unchanged),
  };
};
