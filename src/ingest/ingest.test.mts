import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { loadManifest } from '../nas/manifest.mts';
import { type Embedder, EmbeddingUnavailableError } from '../rag/embed.mts';
import { searchKnowledge } from '../rag/search.mts';
import { openStore, StoreModelMismatchError } from '../rag/store.mts';
import { putFile, tempDir } from '../shared/temp.mts';
import { type FileOutcome, ingest } from './ingest.mts';

const DIMENSIONS = 64;

/** Character-bigram hashing: texts that share words get similar vectors. */
const vectorOf = (text: string): Float32Array => {
  const vector = new Float32Array(DIMENSIONS);
  const chars = [...text.toLowerCase()];
  for (let i = 0; i < chars.length - 1; i++) {
    const pair = `${chars[i]}${chars[i + 1]}`;
    let hash = 0;
    for (const char of pair) {
      hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 9973;
    }
    vector[hash % DIMENSIONS] = (vector[hash % DIMENSIONS] ?? 0) + 1;
  }
  return vector;
};

interface FakeEmbedder extends Embedder {
  readonly batches: string[][];
}

const fakeEmbedder = (
  model = 'fake-embed',
  hook?: (texts: readonly string[], call: number) => void,
): FakeEmbedder => {
  const batches: string[][] = [];
  return {
    batches,
    dimension: DIMENSIONS,
    embedDocuments: async (texts) => {
      batches.push([...texts]);
      hook?.(texts, batches.length);
      return texts.map(vectorOf);
    },
    embedQuery: async (text) => vectorOf(text),
    model,
  };
};

const workbookBytes = async (
  fill: (workbook: ExcelJS.Workbook) => void,
): Promise<Uint8Array> => {
  const workbook = new ExcelJS.Workbook();
  fill(workbook);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
};

const screens = (extra: string[][] = []) =>
  workbookBytes((wb) => {
    const sheet = wb.addWorksheet('画面一覧');
    sheet.addRow(['画面ID', '画面名', '備考']);
    sheet.addRow(['SCR001', 'ログイン', '認証画面']);
    for (const row of extra) {
      sheet.addRow(row);
    }
  });

interface Workspace {
  readonly source: string;
  readonly dataDir: string;
}

const workspace = async (
  t: Parameters<typeof tempDir>[0],
): Promise<Workspace> => {
  const root = await tempDir(t);
  return { dataDir: join(root, 'data'), source: join(root, 'nas') };
};

const run = (
  ws: Workspace,
  embedder: Embedder | undefined,
  extra: Partial<Parameters<typeof ingest>[0]> = {},
) => ingest({ dataDir: ws.dataDir, source: ws.source, ...extra }, embedder);

const summary = (outcomes: readonly FileOutcome[]): string[] =>
  outcomes.map((o) => `${o.action}:${o.path}:${o.status}`);

const seed = async (ws: Workspace) => {
  await putFile(ws.source, 'design/screens.xlsx', await screens());
  await putFile(
    ws.source,
    'notes/readme.md',
    '# 概要\n\nログイン画面の仕様メモ。\n',
  );
  await putFile(ws.source, 'notes/todo.txt', 'あとで確認する事項');
};

describe('ingest', () => {
  it('stores every new file and makes it searchable', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    const embedder = fakeEmbedder();

    const report = await run(ws, embedder);

    assert.deepEqual(summary(report.outcomes), [
      'added:design/screens.xlsx:ok',
      'added:notes/readme.md:ok',
      'added:notes/todo.txt:ok',
    ]);
    assert.equal(report.failed, 0);
    assert.equal(report.aborted, undefined);
    assert.equal(report.stats?.documents, 3);
    assert.equal(report.stats?.model, 'fake-embed');

    const manifest = await loadManifest(join(ws.dataDir, 'manifest.json'));
    assert.deepEqual(Object.keys(manifest.entries).sort(), [
      'design/screens.xlsx',
      'notes/readme.md',
      'notes/todo.txt',
    ]);

    const store = openStore(join(ws.dataDir, 'store.sqlite'), {
      readOnly: true,
    });
    const hits = await searchKnowledge(store, embedder, 'SCR001 画面ID', {
      k: 1,
    });
    assert.equal(hits[0]?.path, 'design/screens.xlsx');
    assert.deepEqual(hits[0]?.refs, ['画面一覧!A1:C2']);
    store.close();
  });

  it('does nothing and embeds nothing on a second run', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    await run(ws, fakeEmbedder());

    const embedder = fakeEmbedder();
    const report = await run(ws, embedder);
    assert.deepEqual(report.outcomes, []);
    assert.equal(report.unchanged, 3);
    assert.equal(embedder.batches.length, 0);
  });

  it('re-embeds a modified file and replaces its chunks', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    await run(ws, fakeEmbedder());

    await putFile(
      ws.source,
      'notes/readme.md',
      '# 概要\n\n支払いの仕様メモ。\n',
      1_700_000_999,
    );
    const embedder = fakeEmbedder();
    const report = await run(ws, embedder);

    assert.deepEqual(summary(report.outcomes), ['changed:notes/readme.md:ok']);
    assert.equal(embedder.batches.length, 1);
    const store = openStore(join(ws.dataDir, 'store.sqlite'), {
      readOnly: true,
    });
    const texts = (await searchKnowledge(store, embedder, '支払い', { k: 10 }))
      .map((hit) => hit.text)
      .join('\n');
    assert.match(texts, /支払い/);
    assert.doesNotMatch(texts, /ログイン画面の仕様メモ/);
    store.close();
  });

  it('removes files that disappeared from the share', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    await run(ws, fakeEmbedder());

    await rm(join(ws.source, 'notes', 'todo.txt'));
    const report = await run(ws, fakeEmbedder());

    assert.deepEqual(summary(report.outcomes), ['removed:notes/todo.txt:ok']);
    assert.equal(report.stats?.documents, 2);
    const manifest = await loadManifest(join(ws.dataDir, 'manifest.json'));
    assert.equal(manifest.entries['notes/todo.txt'], undefined);
  });

  it('only refreshes the mtime of a touched but identical file', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    await run(ws, fakeEmbedder());

    await putFile(
      ws.source,
      'notes/todo.txt',
      'あとで確認する事項',
      1_700_099_999,
    );
    const embedder = fakeEmbedder();
    const report = await run(ws, embedder);

    assert.deepEqual(report.outcomes, []);
    assert.equal(embedder.batches.length, 0);
    const manifest = await loadManifest(join(ws.dataDir, 'manifest.json'));
    assert.equal(
      manifest.entries['notes/todo.txt']?.mtimeMs,
      1_700_099_999_000,
    );
  });

  it('isolates a failing file, keeps the rest, and retries it next time', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    await putFile(ws.source, 'design/broken.xlsx', 'this is not a workbook');

    const first = await run(ws, fakeEmbedder());
    assert.equal(first.failed, 1);
    assert.deepEqual(
      first.outcomes.filter((o) => o.status === 'failed').map((o) => o.path),
      ['design/broken.xlsx'],
    );
    assert.match(first.outcomes[0]?.message ?? '', /not an \.xlsx file/);
    assert.equal(first.stats?.documents, 3);
    const manifest = await loadManifest(join(ws.dataDir, 'manifest.json'));
    assert.equal(manifest.entries['design/broken.xlsx'], undefined);

    const second = await run(ws, fakeEmbedder());
    assert.deepEqual(summary(second.outcomes), [
      'added:design/broken.xlsx:failed',
    ]);

    await putFile(
      ws.source,
      'design/broken.xlsx',
      await screens([['SCR002', 'トップ', '']]),
      1_700_000_500,
    );
    const third = await run(ws, fakeEmbedder());
    assert.deepEqual(summary(third.outcomes), ['added:design/broken.xlsx:ok']);
    assert.equal(third.failed, 0);
  });

  it('keeps the old version when updating a file fails', async (t) => {
    const ws = await workspace(t);
    await putFile(ws.source, 'a.md', '最初の版');
    await run(ws, fakeEmbedder());

    await putFile(ws.source, 'a.md', '二番目の版', 1_700_000_500);
    const failing = fakeEmbedder('fake-embed', () => {
      throw new Error('embedding exploded');
    });
    const report = await run(ws, failing);

    assert.deepEqual(summary(report.outcomes), ['changed:a.md:failed']);
    assert.match(report.outcomes[0]?.message ?? '', /embedding exploded/);
    const store = openStore(join(ws.dataDir, 'store.sqlite'), {
      readOnly: true,
    });
    const [hit] = await searchKnowledge(store, fakeEmbedder(), '版');
    assert.match(hit?.text ?? '', /最初の版/);
    store.close();

    const retried = await run(ws, fakeEmbedder());
    assert.deepEqual(summary(retried.outcomes), ['changed:a.md:ok']);
  });

  it('records unsupported files so they are not retried until they change', async (t) => {
    const ws = await workspace(t);
    const legacy = Uint8Array.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0,
    ]);
    await putFile(ws.source, 'old/locked.xlsx', legacy);
    await putFile(ws.source, 'ok.md', 'fine');

    const first = await run(ws, fakeEmbedder());
    assert.deepEqual(summary(first.outcomes), [
      'added:ok.md:ok',
      'added:old/locked.xlsx:skipped',
    ]);
    assert.match(
      first.outcomes[1]?.message ?? '',
      /legacy \.xls or a password-protected/,
    );
    assert.equal(first.failed, 0);

    const second = await run(ws, fakeEmbedder());
    assert.deepEqual(second.outcomes, []);
    assert.equal(second.unchanged, 2);
  });

  it('stops when Ollama is unreachable and resumes cleanly later', async (t) => {
    const ws = await workspace(t);
    await putFile(ws.source, 'a.md', 'alpha');
    await putFile(ws.source, 'b.md', 'beta');
    await putFile(ws.source, 'c.md', 'gamma');

    const flaky = fakeEmbedder('fake-embed', (_texts, call) => {
      if (call === 2) {
        throw new EmbeddingUnavailableError('Cannot reach Ollama at http://x');
      }
    });
    const first = await run(ws, flaky);

    assert.deepEqual(summary(first.outcomes), [
      'added:a.md:ok',
      'added:b.md:failed',
      'added:c.md:not-attempted',
    ]);
    assert.match(first.aborted ?? '', /Cannot reach Ollama/);
    assert.equal(first.failed, 1);
    const manifest = await loadManifest(join(ws.dataDir, 'manifest.json'));
    assert.deepEqual(Object.keys(manifest.entries), ['a.md']);

    const second = await run(ws, fakeEmbedder());
    assert.deepEqual(summary(second.outcomes), [
      'added:b.md:ok',
      'added:c.md:ok',
    ]);
    assert.equal(second.aborted, undefined);
  });

  it('refuses a store that was built with another model before changing anything', async (t) => {
    const ws = await workspace(t);
    await putFile(ws.source, 'a.md', 'alpha');
    await run(ws, fakeEmbedder('model-a'));

    await putFile(ws.source, 'b.md', 'beta');
    await assert.rejects(
      run(ws, fakeEmbedder('model-b')),
      (error: unknown) => error instanceof StoreModelMismatchError,
    );
    const manifest = await loadManifest(join(ws.dataDir, 'manifest.json'));
    assert.deepEqual(Object.keys(manifest.entries), ['a.md']);
  });

  it('plans a dry run without writing anything or needing an embedder', async (t) => {
    const ws = await workspace(t);
    await seed(ws);

    const report = await run(ws, undefined, { dryRun: true });

    assert.equal(report.dryRun, true);
    assert.deepEqual(summary(report.outcomes), [
      'added:design/screens.xlsx:planned',
      'added:notes/readme.md:planned',
      'added:notes/todo.txt:planned',
    ]);
    assert.equal(
      existsSync(ws.dataDir),
      false,
      'the data directory is not even created',
    );
  });

  it('requires an embedder unless it is a dry run', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    await assert.rejects(run(ws, undefined), /embedder is required/);
  });

  it('heals a deleted store by re-ingesting everything', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    await run(ws, fakeEmbedder());
    await rm(join(ws.dataDir, 'store.sqlite'), { force: true });
    await rm(join(ws.dataDir, 'store.sqlite-wal'), { force: true });
    await rm(join(ws.dataDir, 'store.sqlite-shm'), { force: true });

    const report = await run(ws, fakeEmbedder());
    assert.equal(report.outcomes.length, 3);
    assert.equal(report.stats?.documents, 3);
  });

  it('rebuilds a lost manifest without re-embedding what the store holds', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    await run(ws, fakeEmbedder());
    await rm(join(ws.dataDir, 'manifest.json'));
    await rm(join(ws.source, 'notes', 'todo.txt'));

    const embedder = fakeEmbedder();
    const report = await run(ws, embedder);

    assert.deepEqual(summary(report.outcomes), ['removed:notes/todo.txt:ok']);
    assert.equal(embedder.batches.length, 0);
    const manifest = await loadManifest(join(ws.dataDir, 'manifest.json'));
    assert.deepEqual(Object.keys(manifest.entries).sort(), [
      'design/screens.xlsx',
      'notes/readme.md',
    ]);
  });

  it('refuses to wipe the cache when the share looks unmounted', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    await run(ws, fakeEmbedder());
    await rm(ws.source, { force: true, recursive: true });
    await putFile(ws.source, 'placeholder.png', 'x');

    await assert.rejects(run(ws, fakeEmbedder()), /is the share mounted/);
    const allowed = await run(ws, fakeEmbedder(), { allowEmpty: true });
    assert.equal(allowed.outcomes.length, 3);
    assert.equal(allowed.stats?.documents, 0);
  });

  it('reports progress for every file', async (t) => {
    const ws = await workspace(t);
    await seed(ws);
    const seen: string[] = [];
    await run(ws, fakeEmbedder(), {
      onProgress: (outcome, { index, total }) => {
        seen.push(`${index}/${total} ${outcome.path}`);
      },
    });
    assert.deepEqual(seen, [
      '1/3 design/screens.xlsx',
      '2/3 notes/readme.md',
      '3/3 notes/todo.txt',
    ]);
  });
});
