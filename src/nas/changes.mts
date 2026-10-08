import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { mapLimit } from '../shared/concurrency.mts';
import {
  diffManifest,
  type Manifest,
  type ManifestDiff,
  type ManifestEntry,
} from './manifest.mts';
import {
  realScanIo,
  type ScanError,
  type ScanIo,
  type ScanOptions,
  scanSource,
} from './scan.mts';

/** Computes the hex SHA-256 of a file by streaming it. */
export type FileHasher = (absolutePath: string) => Promise<string>;

export const hashFile: FileHasher = async (absolutePath) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
};

export interface ChangeOptions extends ScanOptions {
  readonly hash?: FileHasher;
  readonly io?: ScanIo;
  /** Hash this many files at once (default 4). */
  readonly concurrency?: number;
  /**
   * Accept a scan that finds no files although files were known before. By
   * default that is an error, because it usually means the share is not
   * mounted and acting on it would delete the whole cache.
   */
  readonly allowEmpty?: boolean;
}

export interface Changes {
  /** The manifest describing the files as they are now. */
  readonly current: Manifest;
  readonly diff: ManifestDiff;
  /** Entries that could not be read this time (their old state is kept). */
  readonly errors: readonly ScanError[];
}

const isUnder = (path: string, directory: string): boolean =>
  path === directory || path.startsWith(`${directory}/`);

/**
 * Scans `root` and compares it with the manifest of the last processed state.
 *
 * Files are re-hashed only when their size or modification time changed. An
 * entry that cannot be read right now (for example a workbook that is open
 * and locked) keeps its previous state instead of being treated as deleted.
 */
export const scanChanges = async (
  root: string,
  previous: Manifest,
  options: ChangeOptions = {},
): Promise<Changes> => {
  const hash = options.hash ?? hashFile;
  const scan = await scanSource(root, options, options.io ?? realScanIo);

  if (
    scan.files.length === 0 &&
    scan.errors.length === 0 &&
    Object.keys(previous.entries).length > 0 &&
    options.allowEmpty !== true
  ) {
    throw new Error(
      `No files found under ${root} although ${Object.keys(previous.entries).length} were known; is the share mounted? Pass allowEmpty to accept it.`,
    );
  }

  const errors: ScanError[] = [...scan.errors];
  const hashed = await mapLimit(
    scan.files,
    options.concurrency ?? 4,
    async (file): Promise<[string, ManifestEntry] | undefined> => {
      const before = previous.entries[file.path];
      if (
        before !== undefined &&
        before.size === file.size &&
        before.mtimeMs === file.mtimeMs
      ) {
        return [file.path, before];
      }
      try {
        const sha256 = await hash(join(root, file.path));
        return [file.path, { mtimeMs: file.mtimeMs, sha256, size: file.size }];
      } catch (error) {
        errors.push({
          kind: 'file',
          message: error instanceof Error ? error.message : String(error),
          path: file.path,
        });
        return undefined;
      }
    },
  );

  const entries: Record<string, ManifestEntry> = {};
  for (const item of hashed) {
    if (item !== undefined) {
      entries[item[0]] = item[1];
    }
  }
  // Keep the old state of anything that could not be read this time.
  for (const [path, entry] of Object.entries(previous.entries)) {
    if (
      entries[path] === undefined &&
      errors.some((e) =>
        e.kind === 'directory' ? isUnder(path, e.path) : e.path === path,
      )
    ) {
      entries[path] = entry;
    }
  }

  const current: Manifest = { entries, version: 1 };
  errors.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { current, diff: diffManifest(previous, current), errors };
};
