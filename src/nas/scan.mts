import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';

/** Extensions that the pipeline can turn into text. */
export const DEFAULT_EXTENSIONS: readonly string[] = [
  '.xlsx',
  '.xlsm',
  '.md',
  '.txt',
];

/**
 * Paths that never hold knowledge: Office lock files, editor temp files and
 * the thumbnail/recycle folders that NAS firmware adds.
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  '**/~$*',
  '**/.~lock.*',
  '**/*.tmp',
  '**/thumbs.db',
  '**/.ds_store',
  '**/@eadir/**',
  '**/#recycle/**',
  '**/.@__thumb/**',
  '**/$recycle.bin/**',
  '**/.git/**',
  '**/node_modules/**',
];

export interface ScanOptions {
  /** Extensions to keep, with the dot; matched case-insensitively. */
  readonly extensions?: readonly string[];
  /** Extra glob patterns (relative POSIX paths) to skip. */
  readonly exclude?: readonly string[];
}

export interface ScannedFile {
  /** Path relative to the source root, always with `/` separators. */
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ScanError {
  /** Relative POSIX path of the entry that could not be read. */
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly message: string;
}

export interface ScanResult {
  readonly files: readonly ScannedFile[];
  readonly errors: readonly ScanError[];
}

/** File system access, injectable so failures can be simulated. */
export interface ScanIo {
  readdir(directory: string): Promise<Dirent[]>;
  stat(
    file: string,
  ): Promise<{ readonly size: number; readonly mtimeMs: number }>;
}

export const realScanIo: ScanIo = {
  readdir: (directory) => readdir(directory, { withFileTypes: true }),
  stat: (file) => stat(file),
};

const matches = (relativePath: string, pattern: string): boolean =>
  posix.matchesGlob(relativePath.toLowerCase(), pattern.toLowerCase());

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Lists the files under `root` that match the options, read-only.
 *
 * Symbolic links found inside the tree are not followed (the root you pass
 * may itself be a link, e.g. a mounted share, and is read as given). A directory or file that cannot be read is
 * reported in `errors` and the walk continues; only an unreadable root throws,
 * because nothing useful can be said about it.
 */
export const scanSource = async (
  root: string,
  options: ScanOptions = {},
  io: ScanIo = realScanIo,
): Promise<ScanResult> => {
  const extensions = new Set(
    (options.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()),
  );
  const excludes = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  // `dir/**` also excludes the directory itself, so the walk can skip it.
  const directoryExcludes = excludes
    .filter((pattern) => pattern.endsWith('/**'))
    .map((pattern) => pattern.slice(0, -3));

  const files: ScannedFile[] = [];
  const errors: ScanError[] = [];

  const walk = async (relativeDir: string): Promise<void> => {
    const absoluteDir = relativeDir === '' ? root : join(root, relativeDir);
    let entries: Dirent[];
    try {
      entries = await io.readdir(absoluteDir);
    } catch (error) {
      if (relativeDir === '') {
        throw new Error(
          `Cannot read source directory ${root}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      errors.push({
        kind: 'directory',
        message: errorMessage(error),
        path: relativeDir,
      });
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative =
        relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        // A pattern may name the directory itself (`private`) or its content
        // (`private/**`); either way the walk does not enter it.
        if (
          !directoryExcludes.some((pattern) => matches(relative, pattern)) &&
          !excludes.some((pattern) => matches(relative, pattern))
        ) {
          await walk(relative);
        }
        continue;
      }
      if (
        !entry.isFile() ||
        !extensions.has(posix.extname(entry.name).toLowerCase()) ||
        excludes.some((pattern) => matches(relative, pattern))
      ) {
        continue;
      }
      try {
        const info = await io.stat(join(root, relative));
        files.push({ mtimeMs: info.mtimeMs, path: relative, size: info.size });
      } catch (error) {
        errors.push({
          kind: 'file',
          message: errorMessage(error),
          path: relative,
        });
      }
    }
  };

  await walk('');
  const byPath = (a: { path: string }, b: { path: string }): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  files.sort(byPath);
  errors.sort(byPath);
  return { errors, files };
};
