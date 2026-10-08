import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from '../shared/temp.mts';
import { formatHits, searchKnowledge, terminalSafe } from './search.mts';
import { openStore } from './store.mts';

const embedderFor = (vector: number[]) => ({
  embedQuery: async (text: string): Promise<Float32Array> => {
    assert.notEqual(text.trim(), '');
    return Float32Array.from(vector);
  },
});

const seeded = async (t: Parameters<typeof tempDir>[0]) => {
  const dir = await tempDir(t);
  const store = openStore(join(dir, 'store.sqlite'), { model: 'm' });
  store.replaceDocument('screens.xlsx', 'a'.repeat(64), [
    {
      embedding: Float32Array.from([1, 0]),
      metadata: {
        headingPath: ['screens.xlsx', '画面'],
        refs: ['画面!A1:C3'],
        sheet: '画面',
        source: 'screens.xlsx',
      },
      text: 'screens.xlsx > 画面\n\n### 画面!A1:C3\n| ID | 名前 |\n| --- | --- |\n| 1 | ログイン |',
    },
    {
      embedding: Float32Array.from([0, 1]),
      metadata: {
        headingPath: ['notes.md'],
        refs: [],
        sheet: undefined,
        source: 'notes.md',
      },
      text: 'notes.md\n\nunrelated',
    },
  ]);
  return store;
};

describe('searchKnowledge', () => {
  it('embeds the query and returns ranked hits with citations', async (t) => {
    const store = await seeded(t);
    const hits = await searchKnowledge(
      store,
      embedderFor([1, 0]),
      'ログイン画面',
      { k: 2 },
    );
    assert.equal(hits.length, 2);
    assert.deepEqual(
      {
        path: hits[0]?.path,
        rank: hits[0]?.rank,
        refs: hits[0]?.refs,
        sheet: hits[0]?.sheet,
      },
      { path: 'screens.xlsx', rank: 1, refs: ['画面!A1:C3'], sheet: '画面' },
    );
    assert.equal(hits[1]?.rank, 2);
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 1));
    store.close();
  });

  it('rejects an empty query', async (t) => {
    const store = await seeded(t);
    await assert.rejects(
      searchKnowledge(store, embedderFor([1, 0]), '  '),
      /query is empty/,
    );
    store.close();
  });
});

describe('formatHits', () => {
  it('says so when nothing matched', () => {
    assert.equal(formatHits([]), 'No matching knowledge found.\n');
  });

  it('does not pass control characters to the terminal', () => {
    const esc = String.fromCharCode(27);
    const text = formatHits([
      {
        path: `evil${esc}]52;c;aGk=${String.fromCharCode(7)}.xlsx`,
        rank: 1,
        refs: [`S${esc}[31m!A1`],
        score: 0.5,
        sheet: undefined,
        text: `cell ${esc}[2J with escape\tand tab`,
      },
    ]);
    assert.ok(!text.includes(esc), 'no ESC survives');
    assert.ok(!text.includes(String.fromCharCode(7)), 'no BEL survives');
    assert.match(text, /evil�\]52;c;aGk=�\.xlsx/);
    assert.equal(terminalSafe('tab\there\nline'), 'tab\there\nline');
  });

  it('cuts the preview between characters, never inside an emoji', () => {
    const hit = {
      path: 'a.md',
      rank: 1,
      refs: [],
      score: 1,
      sheet: undefined,
      text: '😀'.repeat(20),
    };
    for (const limit of [5, 6, 7, 8]) {
      const line = formatHits([hit], limit).split('\n')[1] ?? '';
      const preview = line.trim();
      assert.equal(preview, preview.toWellFormed(), String(limit));
      assert.ok(preview.endsWith('…'));
      assert.equal(Array.from(preview).length, limit);
    }
  });

  it('shows rank, score, path, citations and a one-line preview', async (t) => {
    const store = await seeded(t);
    const hits = await searchKnowledge(store, embedderFor([1, 0]), 'q', {
      k: 1,
    });
    const text = formatHits(hits, 60);
    assert.match(
      text,
      /^1\. \[1\.000\] screens\.xlsx {2}\(画面!A1:C3\)\n {3}screens\.xlsx > 画面 ⏎ /,
    );
    assert.ok(text.split('\n')[1]?.endsWith('…'), 'long text is cut');
    store.close();
  });
});
