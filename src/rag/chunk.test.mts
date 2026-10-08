import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildWorkbookModel } from '../excel/model.mts';
import type { RawCell, RawSheet, WorkbookModel } from '../excel/types.mts';
import {
  type Chunk,
  chunkMarkdown,
  chunkWorkbook,
  hardSplit,
  limitsForContext,
  resolveLimits,
} from './chunk.mts';

const cell = (row: number, column: number, text: string): RawCell => ({
  column,
  kind: 'text',
  row,
  text,
});

const sheet = (name: string, cells: RawCell[]): RawSheet => ({
  cells,
  hiddenColumns: [],
  hiddenRows: [],
  merges: [],
  name,
  state: 'visible',
});

const workbookOf = (...sheets: RawSheet[]): WorkbookModel =>
  buildWorkbookModel('design.xlsx', { sheets });

const workbookFrom = (source: string, sheet: RawSheet): WorkbookModel =>
  buildWorkbookModel(source, { sheets: [sheet] });

/** A table of `rows` data rows under an `ID | Name` header. */
const bigTable = (rows: number, label = 'row'): RawCell[] => [
  cell(1, 1, 'ID'),
  cell(1, 2, 'Name'),
  ...Array.from({ length: rows }, (_, i) => [
    cell(i + 2, 1, String(i + 1)),
    cell(i + 2, 2, `${label}-${i + 1}`),
  ]).flat(),
];

const bodyRows = (chunk: Chunk): string[] =>
  chunk.text.split('\n').filter((line) => /^\| \d+ \|/.test(line));

describe('hardSplit', () => {
  it('returns short text unchanged', () => {
    assert.deepEqual(hardSplit('short', 10), ['short']);
  });

  it('prefers sentence boundaries and loses no text', () => {
    const text =
      'これは最初の文です。これは二番目の文です。これは三番目の文です。';
    const pieces = hardSplit(text, 16);
    assert.ok(pieces.every((piece) => piece.length <= 16));
    assert.equal(pieces.join(''), text);
    assert.ok(pieces[0]?.endsWith('。'));
  });

  it('refuses a limit that could never make progress', () => {
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      assert.throws(() => hardSplit('text', bad), RangeError);
    }
  });

  it('still advances when the limit is one character and a pair does not fit', () => {
    assert.deepEqual(hardSplit('𠮷a', 1).join(''), '𠮷a');
  });

  it('never cuts a surrogate pair', () => {
    const text = '𠮷'.repeat(50);
    const pieces = hardSplit(text, 9);
    assert.equal(pieces.join(''), text);
    for (const piece of pieces) {
      assert.ok(piece.length <= 9);
      assert.equal(piece.length % 2, 0, 'pairs stay together');
    }
  });

  it('cuts at the limit when there is no boundary', () => {
    assert.deepEqual(hardSplit('0123456789', 4), ['0123', '4567', '89']);
  });
});

describe('resolveLimits', () => {
  it('gives the same limits for options that chunk alike', () => {
    assert.deepEqual(resolveLimits({ maxChars: 100, overlapChars: 81 }), {
      max: 100,
      overlap: 25,
    });
    assert.deepEqual(
      resolveLimits({ maxChars: 100, overlapChars: 25 }),
      resolveLimits({ maxChars: 100, overlapChars: 81 }),
    );
    assert.deepEqual(
      resolveLimits({ maxChars: 20 }),
      resolveLimits({ maxChars: 100 }),
    );
    assert.deepEqual(resolveLimits({}), { max: 1000, overlap: 100 });
  });
});

describe('limitsForContext and context lines', () => {
  it('treats a context that is not a finite number like an unknown one', () => {
    assert.deepEqual(limitsForContext(Number.NaN), limitsForContext(undefined));
    assert.deepEqual(
      limitsForContext(Number.POSITIVE_INFINITY),
      limitsForContext(undefined),
    );
  });

  it('shortens a long context line without cutting a surrogate pair', () => {
    // 100 characters is the smallest limit: the context may take 40 of them.
    const source = `${'a'.repeat(38)}😀${'b'.repeat(60)}.xlsx`;
    const chunks = chunkWorkbook(
      {
        sheets: [
          {
            blocks: [
              {
                kind: 'paragraph',
                range: 'A1:A1',
                ref: 'S!A1:A1',
                rows: [['x']],
              },
            ],
            cells: [],
            merges: [],
            name: 'S',
            state: 'visible',
            used: 'A1:A1',
          },
        ],
        source,
      },
      { maxChars: 100 },
    );
    const first = chunks[0]?.text.split('\n')[0] ?? '';
    assert.ok(first.endsWith('…'));
    assert.equal(first, first.toWellFormed(), 'no lone surrogate');
  });
});

describe('limitsForContext', () => {
  it('derives a size from the model context, within sane bounds', () => {
    assert.deepEqual(limitsForContext(512), {
      maxChars: 409,
      overlapChars: 81,
    });
    assert.equal(limitsForContext(8192).maxChars, 1000);
    assert.equal(limitsForContext(64).maxChars, 100);
    assert.equal(limitsForContext(undefined).maxChars, 1000);
  });
});

describe('chunkWorkbook', () => {
  it('puts a small sheet into one self-describing chunk', () => {
    const chunks = chunkWorkbook(
      workbookOf(sheet('画面一覧', bigTable(2, '画面'))),
    );
    assert.equal(chunks.length, 1);
    assert.equal(
      chunks[0]?.text,
      [
        'design.xlsx > 画面一覧',
        '',
        '### 画面一覧!A1:B3',
        '| ID | Name |',
        '| --- | --- |',
        '| 1 | 画面-1 |',
        '| 2 | 画面-2 |',
      ].join('\n'),
    );
    assert.deepEqual(chunks[0]?.metadata, {
      headingPath: ['design.xlsx', '画面一覧'],
      refs: ['画面一覧!A1:B3'],
      sheet: '画面一覧',
      source: 'design.xlsx',
    });
  });

  it('merges small blocks of one sheet and keeps a citation for each', () => {
    const chunks = chunkWorkbook(
      workbookOf(
        sheet('S', [
          cell(1, 1, 'Title'),
          cell(3, 1, 'k'),
          cell(3, 2, 'v'),
          cell(4, 1, 'k2'),
          cell(4, 2, 'v2'),
        ]),
      ),
    );
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0]?.metadata.refs, ['S!A1', 'S!A3:B4']);
    assert.match(
      chunks[0]?.text ?? '',
      /### S!A1\nTitle\n\n### S!A3:B4\n\| k \| v \|/,
    );
  });

  it('never mixes sheets in one chunk', () => {
    const chunks = chunkWorkbook(
      workbookOf(
        sheet('One', [cell(1, 1, 'a')]),
        sheet('Two', [cell(1, 1, 'b')]),
      ),
    );
    assert.deepEqual(
      chunks.map((chunk) => chunk.metadata.sheet),
      ['One', 'Two'],
    );
  });

  it('splits a large table by rows, repeating the column names, losing nothing', () => {
    const chunks = chunkWorkbook(workbookOf(sheet('Big', bigTable(60))), {
      maxChars: 200,
      overlapChars: 0,
    });
    assert.ok(chunks.length > 3);
    for (const chunk of chunks) {
      assert.ok(
        chunk.text.length <= 200,
        `chunk of ${chunk.text.length} chars`,
      );
      assert.match(
        chunk.text,
        /\| ID \| Name \|\n\| --- \| --- \|\n/,
        'header repeated',
      );
      assert.deepEqual(chunk.metadata.refs, ['Big!A1:B61']);
    }
    const ids = chunks
      .flatMap(bodyRows)
      .map((row) => Number(/\d+/.exec(row)?.[0]));
    assert.deepEqual(
      ids,
      Array.from({ length: 60 }, (_, i) => i + 1),
      'every row exactly once, in order',
    );
  });

  it('overlaps consecutive chunks when asked to', () => {
    const chunks = chunkWorkbook(workbookOf(sheet('Big', bigTable(40))), {
      maxChars: 220,
      overlapChars: 40,
    });
    const rows = chunks.map(bodyRows);
    assert.ok(chunks.length > 2);
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1] ?? [];
      const first = rows[i]?.[0] ?? '';
      assert.ok(
        previous.includes(first),
        'a chunk starts with rows of the previous one',
      );
      const overlap = previous.slice(previous.indexOf(first));
      assert.ok(
        overlap.join('\n').length <= 40,
        'the overlap stays within the requested size',
      );
    }
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 220);
    }
  });

  it('cuts an oversized row instead of exceeding the limit', () => {
    const long = 'あ'.repeat(450);
    const chunks = chunkWorkbook(
      workbookOf(sheet('Wide', [cell(1, 1, 'Note'), cell(2, 1, long)])),
      { maxChars: 200, overlapChars: 0 },
    );
    assert.ok(chunks.length >= 3);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 200);
    }
    const kept = chunks
      .map((c) => c.text)
      .join('')
      .replaceAll(/[^あ]/g, '');
    assert.equal(kept.length, 450, 'the full text survives');
  });

  it('turns a table row that cannot fit into labelled lines instead of cutting its pipes', () => {
    const long = 'あ'.repeat(900);
    const chunks = chunkWorkbook(
      workbookOf(
        sheet('Spec', [
          cell(1, 1, 'ID'),
          cell(1, 2, 'Name'),
          cell(1, 3, 'Note'),
          cell(2, 1, '1'),
          cell(2, 2, 'Login'),
          cell(2, 3, long),
          cell(3, 1, '2'),
          cell(3, 2, 'Top'),
          cell(3, 3, 'short'),
        ]),
      ),
      { maxChars: 300, overlapChars: 0 },
    );
    assert.ok(chunks.length >= 4);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 300, `chunk of ${chunk.text.length}`);
      assert.match(
        chunk.text,
        /\| ID \| Name \| Note \|\n\| --- \| --- \| --- \|\n/,
      );
    }
    const body = chunks.map((c) => c.text).join('\n');
    assert.match(body, /ID: 1\nName: Login\n/, 'short cells keep their labels');
    assert.equal(
      body.replaceAll(/[^あ]/g, '').length,
      900,
      'the full text survives',
    );
    assert.ok(
      !body.split('\n').some((line) => line.startsWith('あ')),
      'no fragment lost its label',
    );
    assert.ok(
      body.split('\n').filter((line) => line.startsWith('Note: ')).length >= 3,
      'the long cell is split over several labelled lines',
    );
    assert.match(body, /\| 2 \| Top \| short \|/, 'rows that fit stay rows');
  });

  it('does not repeat a header that leaves almost no room', () => {
    const headers = Array.from(
      { length: 12 },
      (_, i) => `very-long-column-name-${i}`,
    );
    const cells = [
      ...headers.map((text, i) => cell(1, i + 1, text)),
      ...headers.map((_, i) => cell(2, i + 1, `v${i}`)),
    ];
    const chunks = chunkWorkbook(workbookOf(sheet('Wide', cells)), {
      maxChars: 150,
      overlapChars: 0,
    });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 150);
    }
  });

  it('truncates a very long heading instead of blowing the budget', () => {
    const chunks = chunkWorkbook(
      workbookFrom(`${'d'.repeat(300)}.xlsx`, sheet('S', [cell(1, 1, 'x')])),
      { maxChars: 200 },
    );
    assert.equal(chunks.length, 1);
    assert.ok((chunks[0]?.text.length ?? 0) <= 200);
    assert.match(chunks[0]?.text ?? '', /…/);
  });

  it('returns nothing for an empty workbook', () => {
    assert.deepEqual(chunkWorkbook(workbookOf(sheet('Empty', []))), []);
  });
});

describe('chunkMarkdown', () => {
  it('records the heading path of each section', () => {
    const chunks = chunkMarkdown(
      [
        'intro text',
        '',
        '# Guide',
        'overview',
        '',
        '## Setup',
        'steps',
        '',
        '# Other',
        'more',
      ].join('\n'),
      'readme.md',
    );
    assert.deepEqual(
      chunks.map((c) => c.metadata.headingPath),
      [
        ['readme.md'],
        ['readme.md', 'Guide'],
        ['readme.md', 'Guide', 'Setup'],
        ['readme.md', 'Other'],
      ],
    );
    assert.equal(chunks[2]?.text, 'readme.md > Guide > Setup\n\nsteps');
    assert.equal(chunks[2]?.metadata.sheet, undefined);
  });

  it('ignores headings inside fenced code and keeps the fence together', () => {
    const chunks = chunkMarkdown(
      [
        '# Title',
        '```',
        '# not a heading',
        '',
        'still code',
        '```',
        '',
        'after',
      ].join('\n'),
      'a.md',
    );
    assert.equal(chunks.length, 1);
    assert.match(
      chunks[0]?.text ?? '',
      /```\n# not a heading\n\nstill code\n```\n\nafter/,
    );
  });

  it('keeps a Markdown table whole and splits a large one with its header', () => {
    const table = [
      '| a | b |',
      '| --- | --- |',
      ...Array.from({ length: 40 }, (_, i) => `| ${i} | value-${i} |`),
    ].join('\n');
    const chunks = chunkMarkdown(`# T\n\n${table}`, 'doc.md', {
      maxChars: 200,
      overlapChars: 0,
    });
    assert.ok(chunks.length > 2);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 200);
      assert.match(chunk.text, /\| a \| b \|\n\| --- \| --- \|/);
    }
    const rows = chunks.flatMap((c) =>
      c.text.split('\n').filter((l) => /^\| \d+ \|/.test(l)),
    );
    assert.equal(rows.length, 40);
  });

  it('splits long plain text under the limit without losing words', () => {
    const sentence = 'この仕様は重要です。';
    const text = Array.from({ length: 80 }, () => sentence).join('');
    const chunks = chunkMarkdown(text, 'notes.txt', {
      maxChars: 150,
      overlapChars: 0,
    });
    assert.ok(chunks.length > 4);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 150);
    }
    const count =
      chunks
        .map((c) => c.text)
        .join('')
        .split(sentence).length - 1;
    assert.equal(count, 80);
  });

  it('keeps a literal hash at the end of a heading but strips a closing sequence', () => {
    const chunks = chunkMarkdown(
      ['# C#', 'sharp', '', '## Closed ##', 'text'].join('\n'),
      'lang.md',
    );
    assert.deepEqual(
      chunks.map((c) => c.metadata.headingPath),
      [
        ['lang.md', 'C#'],
        ['lang.md', 'C#', 'Closed'],
      ],
    );
  });

  it('recognizes a heading indented by up to three spaces', () => {
    const chunks = chunkMarkdown(['   # Setup', 'steps'].join('\n'), 'x.md');
    assert.deepEqual(chunks[0]?.metadata.headingPath, ['x.md', 'Setup']);
    assert.equal(chunks[0]?.text, 'x.md > Setup\n\nsteps');
    // Four spaces make it a code block, not a heading.
    const code = chunkMarkdown('    # not a heading', 'x.md');
    assert.deepEqual(code[0]?.metadata.headingPath, ['x.md']);
  });

  it('treats a table without outer pipes as a table and repeats its header', () => {
    const table = [
      'Name | Type',
      '--- | ---',
      ...Array.from({ length: 40 }, (_, i) => `field${i} | text${i}`),
    ].join('\n');
    const chunks = chunkMarkdown(table, 'doc.md', {
      maxChars: 200,
      overlapChars: 0,
    });
    assert.ok(chunks.length > 2);
    for (const chunk of chunks) {
      assert.match(chunk.text, /Name \| Type\n--- \| ---\n/);
    }
  });

  it('handles Windows line endings and empty input', () => {
    assert.equal(chunkMarkdown('# A\r\n\r\nbody\r\n', 'x.md').length, 1);
    assert.deepEqual(chunkMarkdown('', 'x.md'), []);
    assert.deepEqual(chunkMarkdown('\n\n  \n', 'x.md'), []);
  });

  it('opens a fence only up to three spaces of indentation', () => {
    const chunks = chunkMarkdown(
      ['# One', '    ```text', '# Two', 'body'].join('\n'),
      'x.md',
    );
    // The indented line is a code block, so it does not hide the next heading.
    assert.deepEqual(
      chunks.map((chunk) => chunk.metadata.headingPath),
      [
        ['x.md', 'One'],
        ['x.md', 'Two'],
      ],
    );
    const fenced = chunkMarkdown(
      ['# One', '   ```', '# not a heading', '   ```', 'after'].join('\n'),
      'x.md',
    );
    assert.deepEqual(
      fenced.map((chunk) => chunk.metadata.headingPath),
      [['x.md', 'One']],
    );
  });

  it('rounds a fractional size down instead of failing on it', () => {
    const long = `${'word '.repeat(300)}end`;
    const whole = chunkMarkdown(long, 'x.md', {
      maxChars: 100,
      overlapChars: 20,
    });
    const fractional = chunkMarkdown(long, 'x.md', {
      maxChars: 100.5,
      overlapChars: 20.7,
    });
    assert.ok(whole.length > 1);
    assert.deepEqual(
      fractional.map((chunk) => chunk.text),
      whole.map((chunk) => chunk.text),
    );
  });

  it('falls back to the default sizes for sizes that are not finite numbers', () => {
    const long = `${'word '.repeat(600)}end`;
    const reference = chunkMarkdown(long, 'x.md');
    assert.ok(reference.length > 1);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const chunks = chunkMarkdown(long, 'x.md', {
        maxChars: bad,
        overlapChars: bad,
      });
      assert.deepEqual(
        chunks.map((chunk) => chunk.text),
        reference.map((chunk) => chunk.text),
      );
    }
  });
});
