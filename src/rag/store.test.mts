import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { tempDir } from '../shared/temp.mts';
import type { ChunkMetadata } from './chunk.mts';
import {
  openStore,
  type StoredChunk,
  StoreModelMismatchError,
} from './store.mts';

const meta = (
  source: string,
  extra: Partial<ChunkMetadata> = {},
): ChunkMetadata => ({
  headingPath: [source],
  refs: [],
  sheet: undefined,
  source,
  ...extra,
});

const chunk = (
  text: string,
  vector: number[],
  extra: Partial<ChunkMetadata> = {},
): StoredChunk => ({
  embedding: Float32Array.from(vector),
  metadata: meta('doc.xlsx', extra),
  text,
});

const openIn = async (
  t: Parameters<typeof tempDir>[0],
  model = 'test-model',
) => {
  const dir = await tempDir(t);
  const file = join(dir, 'store.sqlite');
  return { file, store: openStore(file, { model }) };
};

describe('openStore', () => {
  it('starts empty and remembers the model', async (t) => {
    const { store } = await openIn(t);
    assert.deepEqual(store.stats(), {
      chunks: 0,
      dimension: undefined,
      documents: 0,
      model: 'test-model',
    });
    store.close();
  });

  it('creates missing folders', async (t) => {
    const dir = await tempDir(t);
    const store = openStore(join(dir, 'a', 'b', 'store.sqlite'), {
      model: 'test-model',
    });
    assert.equal(store.stats().documents, 0);
    store.close();
  });

  it('refuses to open any store for writing without naming the model', async (t) => {
    const dir = await tempDir(t);
    assert.throws(
      () => openStore(join(dir, 'store.sqlite')),
      /needs the embedding model/,
    );
    const { file, store } = await openIn(t);
    store.close();
    assert.throws(() => openStore(file), /needs the embedding model/);
  });

  it('uses the default rollback journal and leaves no sidecar files', async (t) => {
    const { file, store } = await openIn(t);
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('x', [1, 0])]);
    store.close();
    const { readdirSync } = await import('node:fs');
    assert.deepEqual(readdirSync(join(file, '..')), ['store.sqlite']);
  });

  it('keeps its content across reopen', async (t) => {
    const { file, store } = await openIn(t);
    store.replaceDocument('a.xlsx', 'a'.repeat(64), [
      chunk('first', [1, 0], { refs: ['S!A1:B2'], sheet: 'S' }),
    ]);
    store.close();

    const reopened = openStore(file, { model: 'test-model' });
    assert.deepEqual(reopened.stats(), {
      chunks: 1,
      dimension: 2,
      documents: 1,
      model: 'test-model',
    });
    const [hit] = reopened.search(Float32Array.from([1, 0]));
    assert.equal(hit?.text, 'first');
    assert.deepEqual(hit?.metadata.refs, ['S!A1:B2']);
    assert.equal(hit?.metadata.sheet, 'S');
    reopened.close();
  });

  it('refuses a store built with another model', async (t) => {
    const { file, store } = await openIn(t, 'model-a');
    store.close();
    assert.throws(
      () => openStore(file, { model: 'model-b' }),
      (error: unknown) =>
        error instanceof StoreModelMismatchError &&
        /"model-a", not "model-b"/.test(error.message),
    );
  });

  it('claims the model of a new store in one step and lets go of the lock when refused', async (t) => {
    const { file, store } = await openIn(t, 'model-a');
    // A second writer that holds another model is refused without leaving a
    // transaction open: the first one keeps working and others can still open.
    assert.throws(() => openStore(file, { model: 'model-b' }));
    assert.throws(() => openStore(file), /needs the embedding model/);
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('x', [1])]);
    const second = openStore(file, { model: 'model-a' });
    assert.equal(second.model, 'model-a');
    assert.equal(second.stats().documents, 1);
    second.close();
    store.close();
    // A new store records the model it was opened with, atomically.
    const fresh = openStore(`${file}.fresh`, { model: 'model-c' });
    assert.equal(fresh.model, 'model-c');
    fresh.close();
  });

  it('says so when a reader meets a store that is still being created', async (t) => {
    const empty = join(await tempDir(t), 'empty.sqlite');
    new DatabaseSync(empty).close();
    assert.throws(
      () => openStore(empty, { readOnly: true }),
      /still being created/,
    );
  });

  it('reads the model from an existing store when none is given', async (t) => {
    const { file, store } = await openIn(t, 'model-a');
    store.close();
    const reader = openStore(file, { readOnly: true });
    assert.equal(reader.model, 'model-a');
    reader.close();
  });

  it('opens read-only, rejects writes and a missing file', async (t) => {
    const { file, store } = await openIn(t);
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('x', [1])]);
    store.close();

    const reader = openStore(file, { readOnly: true });
    assert.equal(reader.search(Float32Array.from([1])).length, 1);
    assert.throws(
      () => reader.replaceDocument('b.md', 'b'.repeat(64), [chunk('y', [1])]),
      /read-only/,
    );
    assert.throws(() => reader.removeDocument('a.md'), /read-only/);
    reader.close();

    const dir = await tempDir(t);
    assert.throws(() =>
      openStore(join(dir, 'missing.sqlite'), { readOnly: true }),
    );
  });
});

describe('replaceDocument and removeDocument', () => {
  it('replaces every chunk of a document atomically', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('a.md', '1'.repeat(64), [
      chunk('old 1', [1, 0]),
      chunk('old 2', [0, 1]),
    ]);
    store.replaceDocument('a.md', '2'.repeat(64), [chunk('new', [1, 1])]);

    assert.deepEqual(store.getDocument('a.md'), {
      chunks: 1,
      path: 'a.md',
      sha256: '2'.repeat(64),
    });
    assert.deepEqual(
      store.search(Float32Array.from([1, 1]), { k: 10 }).map((hit) => hit.text),
      ['new'],
    );
    store.close();
  });

  it('rolls back completely when a chunk is invalid', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('a.md', '1'.repeat(64), [chunk('keep me', [1, 0])]);
    assert.throws(
      () =>
        store.replaceDocument('a.md', '2'.repeat(64), [
          chunk('fine', [1, 0]),
          chunk('wrong size', [1, 0, 0]),
        ]),
      /3 dimensions, the store holds 2/,
    );
    assert.equal(store.getDocument('a.md')?.sha256, '1'.repeat(64));
    assert.deepEqual(
      store.search(Float32Array.from([1, 0])).map((h) => h.text),
      ['keep me'],
    );
    store.close();
  });

  it('refuses mixed dimensions in one call and empty vectors', async (t) => {
    const { store } = await openIn(t);
    assert.throws(
      () =>
        store.replaceDocument('a.md', 'a'.repeat(64), [
          chunk('x', [1, 0]),
          chunk('y', [1]),
        ]),
      /dimensions/,
    );
    assert.throws(
      () => store.replaceDocument('b.md', 'b'.repeat(64), [chunk('x', [])]),
      /empty/,
    );
    assert.equal(store.stats().documents, 0);
    store.close();
  });

  it('refuses vectors with NaN or infinite components', async (t) => {
    const { store } = await openIn(t);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () =>
          store.replaceDocument('a.md', 'a'.repeat(64), [chunk('x', [1, bad])]),
        /NaN or infinite/,
      );
    }
    assert.equal(store.stats().documents, 0);
    store.close();
  });

  it('stores a document without chunks', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('empty.md', 'e'.repeat(64), []);
    assert.equal(store.getDocument('empty.md')?.chunks, 0);
    assert.equal(store.dimension, undefined);
    store.close();
  });

  it('removes a document with its chunks', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('x', [1, 0])]);
    store.replaceDocument('b.md', 'b'.repeat(64), [chunk('y', [0, 1])]);
    assert.equal(store.removeDocument('a.md'), true);
    assert.equal(store.removeDocument('a.md'), false);
    assert.deepEqual(store.stats(), {
      chunks: 1,
      dimension: 2,
      documents: 1,
      model: 'test-model',
    });
    assert.deepEqual(
      store.listDocuments().map((d) => d.path),
      ['b.md'],
    );
    store.close();
  });
});

describe('search', () => {
  const populate = async (t: Parameters<typeof tempDir>[0]) => {
    const { store } = await openIn(t);
    store.replaceDocument('design/screens.xlsx', 'a'.repeat(64), [
      chunk('login screen', [1, 0, 0], { sheet: 'Screens' }),
      chunk('top screen', [0.8, 0.6, 0], { sheet: 'Screens' }),
      chunk('screen notes', [0.6, 0, 0.8], { sheet: 'Notes' }),
    ]);
    store.replaceDocument('design/tables.xlsx', 'b'.repeat(64), [
      chunk('orders table', [0, 1, 0], { sheet: 'Tables' }),
    ]);
    store.replaceDocument('misc/100%_done.md', 'c'.repeat(64), [
      chunk('percent file', [0, 0, 1]),
    ]);
    return store;
  };

  it('ranks by cosine similarity and respects k', async (t) => {
    const store = await populate(t);
    const hits = store.search(Float32Array.from([1, 0, 0]), { k: 3 });
    assert.deepEqual(
      hits.map((h) => h.text),
      ['login screen', 'top screen', 'screen notes'],
    );
    assert.ok(Math.abs((hits[0]?.score ?? 0) - 1) < 1e-6);
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
    assert.equal(
      store.search(Float32Array.from([1, 0, 0]), { k: 1 }).length,
      1,
    );
    assert.equal(store.search(Float32Array.from([1, 0, 0])).length, 5);
    store.close();
  });

  it('normalizes stored vectors and the query', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('big', [30, 40])]);
    const [hit] = store.search(Float32Array.from([6, 8]));
    assert.ok(
      Math.abs((hit?.score ?? 0) - 1) < 1e-6,
      'cosine, not a raw dot product',
    );
    store.close();
  });

  it('filters by path prefix and by sheet', async (t) => {
    const store = await populate(t);
    const query = Float32Array.from([1, 1, 1]);
    assert.deepEqual(
      store
        .search(query, { k: 10, pathPrefix: 'design/' })
        .map((h) => h.path)
        .sort(),
      [
        'design/screens.xlsx',
        'design/screens.xlsx',
        'design/screens.xlsx',
        'design/tables.xlsx',
      ],
    );
    assert.deepEqual(
      store.search(query, { k: 10, sheet: 'Notes' }).map((h) => h.text),
      ['screen notes'],
    );
    assert.deepEqual(
      store.search(query, { pathPrefix: 'misc/100%' }).map((h) => h.text),
      ['percent file'],
    );
    assert.deepEqual(
      store.search(query, { pathPrefix: 'misc/100_' }),
      [],
      'wildcard characters are ordinary characters in a prefix',
    );
    store.close();
  });

  it('matches a path prefix case-sensitively', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('Team/a.md', 'a'.repeat(64), [
      chunk('upper', [1, 0]),
    ]);
    store.replaceDocument('team/a.md', 'b'.repeat(64), [
      chunk('lower', [1, 0]),
    ]);
    store.replaceDocument('日本/設計.md', 'c'.repeat(64), [
      chunk('kanji', [1, 0]),
    ]);
    const query = Float32Array.from([1, 0]);
    assert.deepEqual(
      store.search(query, { pathPrefix: 'Team/' }).map((h) => h.text),
      ['upper'],
    );
    assert.deepEqual(
      store.search(query, { pathPrefix: 'team/' }).map((h) => h.text),
      ['lower'],
    );
    assert.deepEqual(
      store.search(query, { pathPrefix: '日本/' }).map((h) => h.text),
      ['kanji'],
    );
    store.close();
  });

  it('keeps an exact match at the maximum score threshold', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('same', [1, 1, 1])]);
    const hits = store.search(Float32Array.from([1, 1, 1]), { minScore: 1 });
    assert.deepEqual(
      hits.map((h) => h.text),
      ['same'],
    );
    store.close();
  });

  it('validates the result count even when the store is still empty', async (t) => {
    const { store } = await openIn(t);
    for (const k of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => store.search(Float32Array.from([1, 0]), { k }),
        RangeError,
      );
    }
    assert.deepEqual(store.search(Float32Array.from([1, 0])), []);
    store.close();
  });

  it('refuses a query with NaN or infinite components, also on an empty store', async (t) => {
    const { store } = await openIn(t);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => store.search(Float32Array.from([1, bad])),
        /NaN or infinite/,
      );
    }
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('x', [1, 0])]);
    assert.throws(
      () => store.search(Float32Array.from([Number.NaN, 0])),
      /NaN or infinite/,
    );
    store.close();
  });

  it('keeps scores inside the cosine range, also for identical vectors', async (t) => {
    const { store } = await openIn(t);
    const vector = [0.1, 0.7, 0.3, 0.9, 0.2];
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('same', vector)]);
    for (const hit of store.search(Float32Array.from(vector))) {
      assert.ok(hit.score <= 1 && hit.score >= -1, String(hit.score));
    }
    store.close();
  });

  it('admits a perfect match at the top threshold, and nothing below a threshold', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('a.md', 'a'.repeat(64), [
      chunk('same', [1, 1, 1]),
      chunk('near', [1, 1, 0.9]),
    ]);
    const exact = store.search(Float32Array.from([1, 1, 1]), { minScore: 1 });
    assert.deepEqual(
      exact.map((hit) => hit.text),
      ['same'],
    );
    assert.equal(exact[0]?.score, 1);
    const all = store.search(Float32Array.from([1, 1, 1]), { k: 10 });
    const near = all.find((hit) => hit.text === 'near')?.score ?? 0;
    // A threshold just above the near hit's score excludes it.
    const above = store.search(Float32Array.from([1, 1, 1]), {
      k: 10,
      minScore: near + 1e-9,
    });
    assert.deepEqual(
      above.map((hit) => hit.text),
      ['same'],
    );
    store.close();
  });

  it('refuses vectors of another size than the one a second writer fixed', async (t) => {
    const { file, store } = await openIn(t, 'model-a');
    const other = openStore(file, { model: 'model-a' });
    other.replaceDocument('b.md', 'b'.repeat(64), [chunk('three', [1, 0, 0])]);
    assert.throws(
      () =>
        store.replaceDocument('a.md', 'a'.repeat(64), [chunk('two', [1, 0])]),
      /2 dimensions, the store holds 3/,
    );
    other.close();
    store.close();
  });

  it('rejects a minimum score that is not a finite number', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('x', [1, 0])]);
    for (const minScore of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => store.search(Float32Array.from([1, 0]), { minScore }),
        RangeError,
        String(minScore),
      );
    }
    assert.equal(
      store.search(Float32Array.from([1, 0]), { minScore: 0.5 }).length,
      1,
    );
    store.close();
  });

  it('rejects a result count that is not a positive integer', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('x', [1, 0])]);
    for (const k of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => store.search(Float32Array.from([1, 0]), { k }),
        RangeError,
        String(k),
      );
    }
    store.close();
  });

  it('drops results below the minimum score', async (t) => {
    const store = await populate(t);
    const hits = store.search(Float32Array.from([1, 0, 0]), {
      k: 10,
      minScore: 0.7,
    });
    assert.deepEqual(
      hits.map((h) => h.text),
      ['login screen', 'top screen'],
    );
    store.close();
  });

  it('returns nothing for an empty store and rejects a wrong query size', async (t) => {
    const { store } = await openIn(t);
    assert.deepEqual(store.search(Float32Array.from([1, 0])), []);
    store.replaceDocument('a.md', 'a'.repeat(64), [chunk('x', [1, 0])]);
    assert.throws(
      () => store.search(Float32Array.from([1, 0, 0])),
      /3 dimensions, the store holds 2/,
    );
    store.close();
  });

  it('is deterministic when scores tie', async (t) => {
    const { store } = await openIn(t);
    store.replaceDocument('a.md', 'a'.repeat(64), [
      chunk('one', [1, 0]),
      chunk('two', [1, 0]),
      chunk('three', [1, 0]),
    ]);
    const order = () =>
      store.search(Float32Array.from([1, 0])).map((h) => h.text);
    assert.deepEqual(order(), ['one', 'two', 'three']);
    assert.deepEqual(order(), order());
    store.close();
  });
});
