import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChunkMetadata } from './chunk.mts';
import { l2Normalize } from './embed.mts';

/** A chunk with its vector, ready to be stored. */
export interface StoredChunk {
  readonly text: string;
  readonly metadata: ChunkMetadata;
  readonly embedding: Float32Array;
}

export interface SearchResult {
  /** Path of the document, relative to the ingested source. */
  readonly path: string;
  readonly ordinal: number;
  readonly text: string;
  readonly metadata: ChunkMetadata;
  /** Cosine similarity, -1 to 1. */
  readonly score: number;
}

export interface SearchOptions {
  /** Number of results (default 5). */
  readonly k?: number;
  /** Only documents whose path starts with this prefix. */
  readonly pathPrefix?: string;
  /** Only chunks of this sheet. */
  readonly sheet?: string;
  /** Drop results scoring below this similarity. */
  readonly minScore?: number;
}

export interface DocumentInfo {
  readonly path: string;
  readonly sha256: string;
  readonly chunks: number;
}

export interface StoreStats {
  readonly documents: number;
  readonly chunks: number;
  readonly model: string | undefined;
  readonly dimension: number | undefined;
}

/** The cache: documents split into chunks with embeddings. */
export interface VectorStore {
  /** Embedding model the vectors belong to, once known. */
  readonly model: string | undefined;
  /** Vector length, once the first chunk was stored. */
  readonly dimension: number | undefined;
  /**
   * Replaces everything stored for `path` in one transaction, so re-ingesting
   * a changed file never leaves a mix of old and new chunks.
   */
  replaceDocument(
    path: string,
    sha256: string,
    chunks: readonly StoredChunk[],
  ): void;
  /** Removes a document and its chunks; false when it was not stored. */
  removeDocument(path: string): boolean;
  getDocument(path: string): DocumentInfo | undefined;
  listDocuments(): DocumentInfo[];
  /** Brute-force cosine search; vectors are normalized on the way in. */
  search(query: Float32Array, options?: SearchOptions): SearchResult[];
  stats(): StoreStats;
  /**
   * A small named value kept with the store, for example how its documents
   * were produced. Settings never mix with documents or vectors.
   */
  getSetting(name: string): string | undefined;
  setSetting(name: string, value: string): void;
  close(): void;
}

export interface OpenStoreOptions {
  /**
   * Embedding model the caller works with. A store built with another model
   * is refused: vectors of different models cannot be compared.
   */
  readonly model?: string;
  /** Open an existing store without being able to change it. */
  readonly readOnly?: boolean;
}

export class StoreModelMismatchError extends Error {
  constructor(file: string, stored: string, requested: string) {
    super(
      `${file} was built with embedding model "${stored}", not "${requested}". Re-ingest into a new data directory to switch models.`,
    );
    this.name = 'StoreModelMismatchError';
  }
}

const SCHEMA_VERSION = '1';

/** Float32 rounding can leave a perfect match a hair away from +1 or -1. */
const SCORE_EPSILON = 1e-6;

/** A cosine similarity within the Float32 noise of its bounds is on the bound. */
const snapScore = (score: number): number =>
  score > 1 - SCORE_EPSILON ? 1 : score < -1 + SCORE_EPSILON ? -1 : score;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    path TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_path TEXT NOT NULL REFERENCES documents(path) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    metadata TEXT NOT NULL,
    embedding BLOB NOT NULL,
    UNIQUE (document_path, ordinal)
  );
`;

interface ChunkRow {
  readonly document_path: string;
  readonly ordinal: number;
  readonly text: string;
  readonly metadata: string;
  readonly embedding: Uint8Array;
}

const toBlob = (vector: Float32Array): Uint8Array =>
  new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);

const fromBlob = (blob: Uint8Array): Float32Array =>
  new Float32Array(
    blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength),
  );

const dot = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] as number) * (b[i] as number);
  }
  return sum;
};

const parseMetadata = (json: string): ChunkMetadata => {
  const raw = JSON.parse(json) as Partial<ChunkMetadata>;
  return {
    headingPath: raw.headingPath ?? [],
    refs: raw.refs ?? [],
    sheet: raw.sheet ?? undefined,
    source: raw.source ?? '',
  };
};

/** How long a reader waits for a store that is still being created. */
const SCHEMA_WAIT_ATTEMPTS = 10;
const SCHEMA_WAIT_MS = 50;

/** Blocks the calling thread for a moment (the store API is synchronous). */
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const waitForSchema = (db: DatabaseSync, file: string): void => {
  for (let attempt = 0; attempt < SCHEMA_WAIT_ATTEMPTS; attempt++) {
    const found = db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE name = 'meta'")
      .get();
    if (found !== undefined) {
      return;
    }
    pause(SCHEMA_WAIT_MS);
  }
  db.close();
  throw new Error(
    `The store at ${file} is still being created; try again in a moment`,
  );
};

/** Opens (creating when needed) the store in `file`. */
export const openStore = (
  file: string,
  options: OpenStoreOptions = {},
): VectorStore => {
  if (options.readOnly !== true) {
    mkdirSync(dirname(file), { recursive: true });
  }
  const writable = options.readOnly !== true;
  const db = new DatabaseSync(file, { readOnly: options.readOnly === true });
  try {
    // The default rollback journal (not WAL) keeps a read-only mount usable: WAL
    // readers need a writable -shm file. Ingestion is a batch job with short
    // per-document transactions, so readers and the writer only wait briefly.
    // A writer may have to wait for a search that is still reading, so it waits
    // longer than a reader waits for a commit.
    db.exec(
      `PRAGMA busy_timeout = ${options.readOnly === true ? 5000 : 60_000}`,
    );
    db.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    db.close();
    throw error;
  }

  const getMeta = (key: string): string | undefined =>
    (
      db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  const setMeta = (key: string, value: string): void => {
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  };

  if (!writable) {
    // A writer that is creating the store right now has not published its
    // tables yet: wait a moment instead of failing on a half-made file.
    waitForSchema(db, file);
  }

  // Reading the model and claiming it for a new store is one step under the
  // write lock: two writers that open an empty store with different models at
  // the same time cannot both win.
  try {
    if (writable) {
      db.exec('BEGIN IMMEDIATE');
      // The tables appear together with the model: a reader never sees a
      // database that is only partly set up.
      db.exec(SCHEMA);
    }
    const storedModel = getMeta('embedding_model');
    if (
      storedModel !== undefined &&
      options.model !== undefined &&
      storedModel !== options.model
    ) {
      throw new StoreModelMismatchError(file, storedModel, options.model);
    }
    if (writable && options.model === undefined) {
      throw new Error(
        `Opening ${file} for writing needs the embedding model, so vectors of another model are never mixed in`,
      );
    }
    if (writable) {
      setMeta('schema_version', getMeta('schema_version') ?? SCHEMA_VERSION);
      if (storedModel === undefined && options.model !== undefined) {
        setMeta('embedding_model', options.model);
      }
      db.exec('COMMIT');
    }
  } catch (error) {
    if (writable) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // No transaction was open (BEGIN itself failed).
      }
    }
    db.close();
    throw error;
  }

  const currentDimension = (): number | undefined => {
    const value = getMeta('dimension');
    return value === undefined ? undefined : Number(value);
  };

  const requireWritable = (): void => {
    if (options.readOnly === true) {
      throw new Error('The store was opened read-only');
    }
  };

  return {
    close: () => db.close(),

    get dimension() {
      return currentDimension();
    },

    getDocument: (path) => {
      const row = db
        .prepare(
          'SELECT d.path AS path, d.sha256 AS sha256, (SELECT COUNT(*) FROM chunks c WHERE c.document_path = d.path) AS chunks FROM documents d WHERE d.path = ?',
        )
        .get(path) as DocumentInfo | undefined;
      return row === undefined ? undefined : { ...row };
    },

    listDocuments: () =>
      db
        .prepare(
          'SELECT d.path AS path, d.sha256 AS sha256, (SELECT COUNT(*) FROM chunks c WHERE c.document_path = d.path) AS chunks FROM documents d ORDER BY d.path',
        )
        .all()
        .map((row) => ({ ...(row as unknown as DocumentInfo) })),

    get model() {
      return getMeta('embedding_model');
    },

    removeDocument: (path) => {
      requireWritable();
      return (
        Number(
          db.prepare('DELETE FROM documents WHERE path = ?').run(path).changes,
        ) > 0
      );
    },

    replaceDocument: (path, sha256, chunks) => {
      requireWritable();
      for (const chunk of chunks) {
        if (chunk.embedding.length === 0) {
          throw new Error(`Embedding of ${path} is empty`);
        }
        if (!chunk.embedding.every(Number.isFinite)) {
          throw new Error(
            `Embedding of ${path} contains NaN or infinite values`,
          );
        }
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        // Read under the write lock: another writer may have fixed the
        // dimension of an empty store a moment ago.
        const dimension = currentDimension() ?? chunks[0]?.embedding.length;
        for (const chunk of chunks) {
          if (dimension !== undefined && chunk.embedding.length !== dimension) {
            throw new Error(
              `Embedding of ${path} has ${chunk.embedding.length} dimensions, the store holds ${dimension}`,
            );
          }
        }
        db.prepare('DELETE FROM documents WHERE path = ?').run(path);
        db.prepare(
          'INSERT INTO documents (path, sha256, indexed_at) VALUES (?, ?, ?)',
        ).run(path, sha256, new Date().toISOString());
        const insert = db.prepare(
          'INSERT INTO chunks (document_path, ordinal, text, metadata, embedding) VALUES (?, ?, ?, ?, ?)',
        );
        chunks.forEach((chunk, ordinal) => {
          insert.run(
            path,
            ordinal,
            chunk.text,
            JSON.stringify(chunk.metadata),
            toBlob(l2Normalize(chunk.embedding)),
          );
        });
        if (dimension !== undefined && currentDimension() === undefined) {
          setMeta('dimension', String(dimension));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    search: (query, searchOptions = {}) => {
      const k = searchOptions.k ?? 5;
      if (!Number.isInteger(k) || k < 1) {
        throw new RangeError(`k must be a positive integer, got ${k}`);
      }
      if (!query.every(Number.isFinite)) {
        throw new RangeError('The query contains NaN or infinite values');
      }
      if (
        searchOptions.minScore !== undefined &&
        !Number.isFinite(searchOptions.minScore)
      ) {
        throw new RangeError(
          `minScore must be a finite number, got ${searchOptions.minScore}`,
        );
      }
      const dimension = currentDimension();
      if (dimension === undefined) {
        return [];
      }
      if (query.length !== dimension) {
        throw new Error(
          `Query has ${query.length} dimensions, the store holds ${dimension}; was it embedded with "${getMeta('embedding_model') ?? 'the store model'}"?`,
        );
      }
      const unit = l2Normalize(query);
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (searchOptions.pathPrefix !== undefined) {
        // substr, not LIKE: a prefix must match exactly, case included, and
        // `%` or `_` in a path are ordinary characters. substr counts code
        // points, so count them the same way.
        where.push('substr(document_path, 1, ?) = ?');
        params.push(
          [...searchOptions.pathPrefix].length,
          searchOptions.pathPrefix,
        );
      }
      if (searchOptions.sheet !== undefined) {
        where.push("json_extract(metadata, '$.sheet') = ?");
        params.push(searchOptions.sheet);
      }
      // A stable scan order makes ties in the score deterministic.
      const statement = db.prepare(
        `SELECT document_path, ordinal, text, metadata, embedding FROM chunks${
          where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
        } ORDER BY document_path, ordinal`,
      );

      const top: { score: number; row: ChunkRow }[] = [];
      for (const raw of statement.iterate(...params)) {
        const row = raw as unknown as ChunkRow;
        const score = snapScore(dot(unit, fromBlob(row.embedding)));
        if (
          searchOptions.minScore !== undefined &&
          score < searchOptions.minScore
        ) {
          continue;
        }
        if (
          top.length === k &&
          score <= (top[k - 1] as { score: number }).score
        ) {
          continue;
        }
        let at = top.findIndex((entry) => score > entry.score);
        if (at < 0) {
          at = top.length;
        }
        top.splice(at, 0, { row: { ...row }, score });
        if (top.length > k) {
          top.pop();
        }
      }
      return top.map(({ row, score }) => ({
        metadata: parseMetadata(row.metadata),
        ordinal: row.ordinal,
        path: row.document_path,
        score,
        text: row.text,
      }));
    },

    getSetting: (name) => getMeta(`setting:${name}`),

    setSetting: (name, value) => {
      requireWritable();
      setMeta(`setting:${name}`, value);
    },

    stats: () => ({
      chunks: Number(
        (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number })
          .n,
      ),
      dimension: currentDimension(),
      documents: Number(
        (
          db.prepare('SELECT COUNT(*) AS n FROM documents').get() as {
            n: number;
          }
        ).n,
      ),
      model: getMeta('embedding_model'),
    }),
  };
};
