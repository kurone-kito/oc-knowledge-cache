import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type ChangeOptions, scanChanges } from '../nas/changes.mts';
import {
  loadManifest,
  type Manifest,
  type ManifestEntry,
  saveManifest,
} from '../nas/manifest.mts';
import type { ScanError } from '../nas/scan.mts';
import type { ChunkOptions } from '../rag/chunk.mts';
import { type Embedder, EmbeddingUnavailableError } from '../rag/embed.mts';
import { openStore, type StoreStats, type VectorStore } from '../rag/store.mts';
import { type LoadResult, loadDocument } from './documents.mts';

export type IngestAction = 'added' | 'changed' | 'removed';

/**
 * - `ok`: stored (or removed).
 * - `skipped`: a scanned file that is unreadable by design (a legacy `.xls`
 *   workbook under an `.xlsx` name, an encrypted one, binary content);
 *   recorded so it is not retried until the file changes. Files with the
 *   extension `.xls` are not scanned at all until #16 adds support.
 * - `failed`: left as it was and retried by the next run.
 * - `planned`: a dry run would do it.
 * - `not-attempted`: the run stopped before reaching it.
 */
export type IngestStatus =
  | 'ok'
  | 'skipped'
  | 'failed'
  | 'planned'
  | 'not-attempted';

export interface FileOutcome {
  readonly path: string;
  readonly action: IngestAction;
  readonly status: IngestStatus;
  /** Chunks stored for the file. */
  readonly chunks: number | undefined;
  readonly message: string | undefined;
}

export interface IngestReport {
  readonly outcomes: readonly FileOutcome[];
  readonly unchanged: number;
  /** Entries that could not be read this time; their stored state is kept. */
  readonly unreadable: readonly ScanError[];
  readonly dryRun: boolean;
  /** Why the run stopped early, e.g. Ollama is unreachable. */
  readonly aborted: string | undefined;
  readonly failed: number;
  readonly stats: StoreStats | undefined;
}

export interface IngestOptions
  extends Pick<ChangeOptions, 'extensions' | 'exclude' | 'allowEmpty'> {
  /** Directory to ingest, e.g. a mounted NAS share. Never written to. */
  readonly source: string;
  /** Holds `manifest.json` and `store.sqlite`. */
  readonly dataDir: string;
  readonly dryRun?: boolean;
  readonly includeHidden?: boolean;
  readonly chunk?: ChunkOptions;
  readonly onProgress?: (
    outcome: FileOutcome,
    position: { readonly index: number; readonly total: number },
  ) => void;
}

/** Replaceable parts, for tests. */
export interface IngestDeps {
  readonly openStore?: typeof openStore;
  readonly load?: (
    absolutePath: string,
    relativePath: string,
  ) => Promise<LoadResult>;
  /** Persist the manifest at least this often (default 5 s). */
  readonly saveEveryMs?: number;
  readonly now?: () => number;
}

interface PlannedFile {
  readonly path: string;
  readonly action: IngestAction;
}

interface Analysis {
  readonly previous: Manifest;
  readonly current: Manifest;
  readonly plan: readonly PlannedFile[];
  readonly unchanged: readonly string[];
  readonly unreadable: readonly ScanError[];
}

const SAVE_EVERY_FILES = 25;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Keeps only the manifest entries that the store confirms (same path and
 * hash). Anything else is re-ingested, which heals a deleted store or a store
 * and manifest that drifted apart.
 */
const confirmedBy = (
  manifest: Manifest,
  stored: ReadonlyMap<string, string>,
): Manifest => ({
  entries: Object.fromEntries(
    Object.entries(manifest.entries).filter(
      ([path, entry]) => stored.get(path) === entry.sha256,
    ),
  ),
  version: 1,
});

/** Works out what has to be done, without changing anything. */
const analyse = async (
  options: IngestOptions,
  manifestFile: string,
  documents: Pick<VectorStore, 'listDocuments'>,
): Promise<Analysis> => {
  const stored = new Map(
    documents.listDocuments().map((doc) => [doc.path, doc.sha256]),
  );
  const previous = confirmedBy(await loadManifest(manifestFile), stored);
  const { current, diff, errors } = await scanChanges(
    options.source,
    previous,
    {
      ...(options.allowEmpty === undefined
        ? {}
        : { allowEmpty: options.allowEmpty }),
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      ...(options.extensions === undefined
        ? {}
        : { extensions: options.extensions }),
    },
  );
  // The store is the truth for what is indexed: whatever it holds that is no
  // longer in the source goes, even if the manifest never knew about it.
  const removed = [...stored.keys()]
    .filter((path) => current.entries[path] === undefined)
    .sort();
  // A file the store already holds in this exact version needs no work, even
  // when the manifest lost track of it.
  const inSync = (path: string): boolean =>
    stored.get(path) === current.entries[path]?.sha256;
  return {
    current,
    plan: [
      ...removed.map((path) => ({ action: 'removed' as const, path })),
      ...diff.added
        .filter((path) => !inSync(path))
        .map((path) => ({ action: 'added' as const, path })),
      ...diff.changed
        .filter((path) => !inSync(path))
        .map((path) => ({ action: 'changed' as const, path })),
    ],
    previous,
    unchanged: [
      ...diff.unchanged,
      ...diff.added.filter(inSync),
      ...diff.changed.filter(inSync),
    ],
    unreadable: errors,
  };
};

/**
 * Brings the cache in line with the source directory: new and changed files
 * are converted, chunked, embedded and stored; files that disappeared are
 * removed. The source is only read.
 *
 * A file's manifest entry is committed only after its store transaction, so a
 * crash or a failing file never marks anything as processed that is not.
 * With `dryRun` nothing is written and no embedder is needed.
 */
export const ingest = async (
  options: IngestOptions,
  embedder: Embedder | undefined,
  deps: IngestDeps = {},
): Promise<IngestReport> => {
  const manifestFile = join(options.dataDir, 'manifest.json');
  const storeFile = join(options.dataDir, 'store.sqlite');
  const open = deps.openStore ?? openStore;

  if (options.dryRun === true) {
    // Look at an existing store without changing it, and never create one.
    const store = existsSync(storeFile)
      ? open(storeFile, { readOnly: true })
      : undefined;
    try {
      const analysis = await analyse(
        options,
        manifestFile,
        store ?? { listDocuments: () => [] },
      );
      return {
        aborted: undefined,
        dryRun: true,
        failed: 0,
        outcomes: analysis.plan.map(({ action, path }) => ({
          action,
          chunks: undefined,
          message: undefined,
          path,
          status: 'planned' as const,
        })),
        stats: undefined,
        unchanged: analysis.unchanged.length,
        unreadable: analysis.unreadable,
      };
    } finally {
      store?.close();
    }
  }

  if (embedder === undefined) {
    throw new Error('An embedder is required unless dryRun is set');
  }
  // Fails here, before anything changes, if the store was built with another model.
  const store = open(storeFile, { model: embedder.model });
  try {
    return await apply(
      options,
      deps,
      embedder,
      store,
      manifestFile,
      await analyse(options, manifestFile, store),
    );
  } finally {
    store.close();
  }
};

const apply = async (
  options: IngestOptions,
  deps: IngestDeps,
  embedder: Embedder,
  store: VectorStore,
  manifestFile: string,
  { current, plan, previous, unchanged, unreadable }: Analysis,
): Promise<IngestReport> => {
  const now = deps.now ?? Date.now;
  const saveEveryMs = deps.saveEveryMs ?? 5000;
  const load =
    deps.load ??
    ((absolute, relative) =>
      loadDocument(absolute, relative, {
        ...(options.chunk === undefined ? {} : { chunk: options.chunk }),
        includeHidden: options.includeHidden === true,
      }));

  // The manifest follows the store: it starts from what the store confirmed,
  // and each file is added or dropped only after its own transaction.
  const entries: Record<string, ManifestEntry> = { ...previous.entries };
  // Touched-but-identical files only need their new mtime remembered.
  for (const path of unchanged) {
    const entry = current.entries[path];
    if (entry !== undefined) {
      entries[path] = entry;
    }
  }
  let dirty = unchanged.some(
    (path) => previous.entries[path] !== current.entries[path],
  );
  let sinceSave = 0;
  let lastSave = now();
  const save = async (): Promise<void> => {
    await saveManifest(manifestFile, { entries, version: 1 });
    dirty = false;
    sinceSave = 0;
    lastSave = now();
  };

  const outcomes: FileOutcome[] = [];
  let aborted: string | undefined;

  try {
    for (const { action, path } of plan) {
      const record = (
        status: IngestStatus,
        chunks?: number,
        message?: string,
      ): void => {
        const outcome: FileOutcome = { action, chunks, message, path, status };
        outcomes.push(outcome);
        options.onProgress?.(outcome, {
          index: outcomes.length,
          total: plan.length,
        });
      };

      if (aborted !== undefined) {
        record('not-attempted');
        continue;
      }

      if (action === 'removed') {
        store.removeDocument(path);
        delete entries[path];
        dirty = true;
        record('ok');
      } else {
        const entry = current.entries[path] as ManifestEntry;
        const loaded = await load(join(options.source, path), path);
        if (loaded.status === 'failed') {
          record('failed', undefined, loaded.message);
          continue;
        }
        if (loaded.status === 'unsupported') {
          store.replaceDocument(path, entry.sha256, []);
          entries[path] = entry;
          dirty = true;
          record('skipped', 0, loaded.message);
          continue;
        }
        try {
          const texts = loaded.chunks.map((chunk) => chunk.text);
          const vectors =
            texts.length > 0 ? await embedder.embedDocuments(texts) : [];
          store.replaceDocument(
            path,
            entry.sha256,
            loaded.chunks.map((chunk, i) => ({
              embedding: vectors[i] as Float32Array,
              metadata: chunk.metadata,
              text: chunk.text,
            })),
          );
          entries[path] = entry;
          dirty = true;
          record('ok', loaded.chunks.length);
        } catch (error) {
          if (error instanceof EmbeddingUnavailableError) {
            aborted = error.message;
          }
          record('failed', undefined, errorMessage(error));
        }
      }

      sinceSave++;
      if (
        dirty &&
        (sinceSave >= SAVE_EVERY_FILES || now() - lastSave >= saveEveryMs)
      ) {
        await save();
      }
    }
  } finally {
    if (dirty) {
      await save();
    }
  }

  return {
    aborted,
    dryRun: false,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    outcomes,
    stats: store.stats(),
    unchanged: unchanged.length,
    unreadable,
  };
};
