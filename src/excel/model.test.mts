import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { workbookToMarkdown } from './markdown.mts';
import { buildWorkbookModel } from './model.mts';
import type { CellKind, RawCell, RawSheet } from './types.mts';

const cell = (
  row: number,
  column: number,
  text: string,
  extra: Partial<RawCell> = {},
): RawCell => ({ column, kind: 'text' as CellKind, row, text, ...extra });

const sheet = (cells: RawCell[], extra: Partial<RawSheet> = {}): RawSheet => ({
  cells,
  hiddenColumns: [],
  hiddenRows: [],
  merges: [],
  name: 'Sheet1',
  state: 'visible',
  ...extra,
});

const build = (raw: RawSheet, includeHidden = false) =>
  buildWorkbookModel('book.xlsx', { sheets: [raw] }, { includeHidden })
    .sheets[0];

describe('block detection', () => {
  it('turns a contiguous grid into one table with its range', () => {
    const model = build(
      sheet([
        cell(1, 1, 'ID'),
        cell(1, 2, 'Name'),
        cell(2, 1, '1'),
        cell(2, 2, 'Alice'),
        cell(3, 1, '2'),
        cell(3, 2, 'Bob'),
      ]),
    );
    assert.equal(model?.blocks.length, 1);
    assert.deepEqual(model?.blocks[0], {
      kind: 'table',
      range: 'A1:B3',
      ref: 'Sheet1!A1:B3',
      rows: [
        ['ID', 'Name'],
        ['1', 'Alice'],
        ['2', 'Bob'],
      ],
    });
    assert.equal(model?.used, 'A1:B3');
  });

  it('splits blocks at empty rows and empty columns', () => {
    const model = build(
      sheet([
        cell(1, 1, 'T1 head'),
        cell(1, 2, 'x'),
        cell(2, 1, 'a'),
        cell(2, 2, 'b'),
        // empty row 3, then a block that sits in columns D-E next to another in A-B
        cell(4, 1, 'U head'),
        cell(4, 2, 'y'),
        cell(4, 4, 'V head'),
        cell(4, 5, 'z'),
      ]),
    );
    assert.deepEqual(
      model?.blocks.map((b) => b.ref),
      ['Sheet1!A1:B2', 'Sheet1!A4:B4', 'Sheet1!D4:E4'],
    );
  });

  it('keeps side-by-side tables apart even when their heights differ', () => {
    const model = build(
      sheet([
        cell(1, 1, 'L1'),
        cell(2, 1, 'L2'),
        cell(3, 1, 'L3'),
        cell(2, 3, 'R1'),
        cell(3, 3, 'R2'),
      ]),
    );
    assert.deepEqual(
      model?.blocks.map((b) => [b.ref, b.kind]),
      [
        ['Sheet1!A1:A3', 'list'],
        ['Sheet1!C2:C3', 'list'],
      ],
    );
  });

  it('classifies single cells as paragraphs and single columns as lists', () => {
    const model = build(
      sheet([cell(1, 1, 'Title'), cell(3, 1, 'one'), cell(4, 1, 'two')]),
    );
    assert.deepEqual(
      model?.blocks.map((b) => [b.kind, b.rows]),
      [
        ['paragraph', [['Title']]],
        ['list', [['one'], ['two']]],
      ],
    );
  });

  it('does not split a table at a hidden row or column', () => {
    const raw = sheet(
      [
        cell(1, 1, 'a'),
        cell(1, 3, 'b'),
        cell(2, 1, 'hidden row text'),
        cell(3, 1, 'c'),
        cell(3, 3, 'd'),
      ],
      { hiddenColumns: [2], hiddenRows: [2] },
    );
    const model = build(raw);
    assert.equal(model?.blocks.length, 1);
    assert.deepEqual(model?.blocks[0]?.rows, [
      ['a', 'b'],
      ['c', 'd'],
    ]);
    assert.equal(model?.blocks[0]?.ref, 'Sheet1!A1:C3');
  });
});

describe('merged cells', () => {
  it('splits a merged title off its table so the header row is the real header', () => {
    const model = build(
      sheet(
        [
          cell(1, 1, 'Screen list'),
          cell(2, 1, 'No'),
          cell(2, 2, 'Name'),
          cell(2, 3, 'Owner'),
          cell(3, 1, '1'),
          cell(3, 2, 'Login'),
          cell(3, 3, 'Ann'),
        ],
        { merges: ['A1:C1'] },
      ),
    );
    assert.deepEqual(
      model?.blocks.map((b) => [b.kind, b.ref, b.rows]),
      [
        ['paragraph', 'Sheet1!A1:C1', [['Screen list']]],
        [
          'table',
          'Sheet1!A2:C3',
          [
            ['No', 'Name', 'Owner'],
            ['1', 'Login', 'Ann'],
          ],
        ],
      ],
    );
    assert.equal(model?.cells[0]?.merged, 'A1:C1');
  });

  it('measures the table without the merged tail of a wider title', () => {
    const model = build(
      sheet(
        [
          cell(1, 1, 'Wide title'),
          cell(2, 1, 'No'),
          cell(2, 2, 'Name'),
          cell(3, 1, '1'),
          cell(3, 2, 'Login'),
        ],
        { merges: ['A1:D1'] },
      ),
    );
    assert.deepEqual(
      model?.blocks.map((b) => [b.kind, b.ref, b.rows[0]?.length]),
      [
        ['paragraph', 'Sheet1!A1:D1', 1],
        ['table', 'Sheet1!A2:B3', 2],
      ],
    );
  });

  it('keeps stacked title rows as separate paragraphs, but a lone row under a table stays in it', () => {
    const titles = build(
      sheet([
        cell(1, 1, 'Title'),
        cell(2, 1, 'Subtitle'),
        cell(3, 1, 'a'),
        cell(3, 2, 'b'),
        cell(4, 1, 'c'),
        cell(4, 2, 'd'),
      ]),
    );
    assert.deepEqual(
      titles?.blocks.map((b) => [b.kind, b.ref]),
      [
        ['paragraph', 'Sheet1!A1:B1'],
        ['paragraph', 'Sheet1!A2:B2'],
        ['table', 'Sheet1!A3:B4'],
      ],
    );

    const total = build(
      sheet([
        cell(1, 1, 'k'),
        cell(1, 2, 'v'),
        cell(2, 1, 'k2'),
        cell(2, 2, 'v2'),
        cell(3, 1, 'Total'),
      ]),
    );
    assert.equal(total?.blocks.length, 1, 'only leading rows are titles');
    assert.equal(total?.blocks[0]?.rows.length, 3);
  });

  it('leaves a single column of values, with no table, as one list', () => {
    const model = build(
      sheet([cell(1, 1, 'a'), cell(2, 1, 'b'), cell(3, 1, 'c')]),
    );
    assert.deepEqual(
      model?.blocks.map((b) => b.kind),
      ['list'],
    );
  });

  it('repeats a vertically merged value in every row it spans', () => {
    const model = build(
      sheet(
        [
          cell(1, 1, 'Group'),
          cell(1, 2, 'Item'),
          cell(2, 1, 'Fruit'),
          cell(2, 2, 'Apple'),
          cell(3, 2, 'Pear'),
          cell(4, 1, 'Veg'),
          cell(4, 2, 'Leek'),
        ],
        { merges: ['A2:A3'] },
      ),
    );
    assert.deepEqual(model?.blocks[0]?.rows, [
      ['Group', 'Item'],
      ['Fruit', 'Apple'],
      ['Fruit', 'Pear'],
      ['Veg', 'Leek'],
    ]);
  });

  it('fills only the first column of a two-dimensional merge', () => {
    const model = build(
      sheet([cell(1, 1, 'Big'), cell(1, 3, 'x'), cell(2, 3, 'y')], {
        merges: ['A1:B2'],
      }),
    );
    assert.deepEqual(model?.blocks[0]?.rows, [
      ['Big', 'x'],
      ['Big', 'y'],
    ]);
  });
});

describe('hidden content', () => {
  const raw = sheet(
    [
      cell(1, 1, 'shown'),
      cell(2, 1, 'secret row'),
      cell(1, 2, 'secret column'),
    ],
    { hiddenColumns: [2], hiddenRows: [2] },
  );

  it('is left out by default', () => {
    const model = build(raw);
    assert.deepEqual(model?.blocks[0]?.rows, [['shown']]);
    assert.deepEqual(
      model?.cells.map((c) => c.text),
      ['shown'],
    );
  });

  it('is included and flagged on request', () => {
    const model = build(raw, true);
    assert.equal(model?.cells.length, 3);
    assert.deepEqual(
      model?.cells.map((c) => [c.text, c.hidden === true]),
      [
        ['shown', false],
        ['secret column', true],
        ['secret row', true],
      ],
    );
  });

  it('does not split a table at an empty hidden row, also when hidden content is wanted', () => {
    const raw = sheet(
      [cell(1, 1, 'a'), cell(1, 2, 'b'), cell(3, 1, 'c'), cell(3, 2, 'd')],
      { hiddenRows: [2] },
    );
    assert.equal(build(raw)?.blocks.length, 1);
    assert.equal(build(raw, true)?.blocks.length, 1);
  });

  it('drops a hidden sheet unless asked, but still lists it', () => {
    const hidden = sheet([cell(1, 1, 'x')], {
      name: 'Internal',
      state: 'veryHidden',
    });
    const without = buildWorkbookModel('b.xlsx', { sheets: [hidden] });
    assert.deepEqual(without.sheets[0], {
      blocks: [],
      cells: [],
      merges: [],
      name: 'Internal',
      state: 'veryHidden',
      used: undefined,
    });
    const withHidden = buildWorkbookModel(
      'b.xlsx',
      { sheets: [hidden] },
      { includeHidden: true },
    );
    assert.equal(withHidden.sheets[0]?.blocks.length, 1);
    assert.equal(withHidden.sheets[0]?.cells[0]?.hidden, true);
  });
});

describe('very large merged ranges', () => {
  it('does not walk a merge that spans the whole sheet', () => {
    const model = build(
      sheet(
        [
          cell(1, 1, 'Title'),
          cell(2, 1, 'ID'),
          cell(2, 2, 'Name'),
          cell(3, 1, '1'),
          cell(3, 2, 'Alice'),
        ],
        { merges: ['A1:XFD1048576'] },
      ),
    );
    assert.ok((model?.blocks.length ?? 0) >= 1);
    assert.ok(
      model?.blocks.some((block) => block.rows.flat().includes('Alice')),
    );
  });
});

describe('cell decoration', () => {
  it('renders web and sheet links and notes next to the text', () => {
    const model = build(
      sheet([
        cell(1, 1, 'Spec', { hyperlink: 'https://example.com/spec' }),
        cell(1, 2, 'Internal', { hyperlink: '#Sheet2!A1' }),
        cell(2, 1, 'Limit', { note: 'agreed on 2026-01-05' }),
        cell(2, 2, '10'),
      ]),
    );
    assert.deepEqual(model?.blocks[0]?.rows, [
      ['[Spec](https://example.com/spec)', '[Internal](#Sheet2!A1)'],
      ['Limit [note: agreed on 2026-01-05]', '10'],
    ]);
  });

  it('escapes the label and the destination of a link', () => {
    const model = build(
      sheet([
        cell(1, 1, 'A]B [x]', {
          hyperlink: 'https://example.com/a_(b)?q=1 2',
        }),
        cell(1, 2, '', { hyperlink: 'https://example.com/' }),
      ]),
    );
    assert.deepEqual(model?.blocks[0]?.rows, [
      [
        '[A\\]B \\[x\\]](https://example.com/a_%28b%29?q=1%202)',
        '[https://example.com/](https://example.com/)',
      ],
    ]);
  });

  it('keeps a formula whose cached result is empty as content', () => {
    const model = build(
      sheet([
        cell(1, 1, 'Name'),
        cell(1, 2, 'Note'),
        cell(2, 1, 'A'),
        cell(2, 2, '', { formula: 'IF(A2="","","x")', kind: 'formula' }),
      ]),
    );
    assert.equal(model?.blocks.length, 1);
    assert.equal(model?.used, 'A1:B2');
    assert.equal(
      model?.cells.find((c) => c.address === 'B2')?.formula,
      'IF(A2="","","x")',
    );
  });

  it('keeps the raw text and metadata in the JSON cells', () => {
    const model = build(
      sheet([cell(1, 1, 'Total', { formula: 'SUM(B1:B2)', kind: 'formula' })]),
    );
    assert.deepEqual(model?.cells[0], {
      address: 'A1',
      column: 1,
      formula: 'SUM(B1:B2)',
      kind: 'formula',
      row: 1,
      text: 'Total',
    });
  });

  it('keeps a note that sits on a cell without a value', () => {
    const model = build(
      sheet([
        cell(1, 1, 'Limit'),
        cell(1, 2, '10'),
        cell(2, 1, '', { note: 'agreed on 2026-01-05' }),
        cell(2, 2, '20'),
      ]),
    );
    assert.deepEqual(model?.blocks[0]?.rows, [
      ['Limit', '10'],
      ['[note: agreed on 2026-01-05]', '20'],
    ]);
    assert.equal(
      model?.cells.find((c) => c.address === 'A2')?.note,
      'agreed on 2026-01-05',
    );
  });

  it('ignores cells that only contain whitespace', () => {
    const model = build(sheet([cell(1, 1, '   '), cell(2, 1, 'x')]));
    assert.deepEqual(
      model?.blocks.map((b) => b.ref),
      ['Sheet1!A2'],
    );
  });
});

describe('workbookToMarkdown', () => {
  it('renders sections, citations, escaped pipes and line breaks', () => {
    const workbook = buildWorkbookModel('design.xlsx', {
      sheets: [
        sheet([
          cell(1, 1, 'Key'),
          cell(1, 2, 'Value'),
          cell(2, 1, 'a|b'),
          cell(2, 2, 'line1\nline2'),
        ]),
        sheet([cell(1, 1, 'Only a title')], { name: 'My Sheet' }),
        sheet([], { name: 'Empty' }),
      ],
    });
    assert.equal(
      workbookToMarkdown(workbook),
      [
        '# design.xlsx',
        '',
        '## Sheet1',
        '',
        '### Sheet1!A1:B2',
        '',
        '| Key | Value |',
        '| --- | --- |',
        '| a\\|b | line1<br>line2 |',
        '',
        '## My Sheet',
        '',
        "### 'My Sheet'!A1",
        '',
        'Only a title',
        '',
      ].join('\n'),
    );
  });

  it('renders a list and pads ragged table rows', () => {
    const workbook = buildWorkbookModel('x.xlsx', {
      sheets: [sheet([cell(1, 1, 'one'), cell(2, 1, 'two\nlines')])],
    });
    assert.match(workbookToMarkdown(workbook), /- one\n- two lines\n$/);
  });

  it('keeps a backslash in front of a pipe from swallowing the pipe', () => {
    const workbook = buildWorkbookModel('x.xlsx', {
      sheets: [
        sheet([
          cell(1, 1, 'Pattern'),
          cell(1, 2, 'Note'),
          cell(2, 1, String.raw`a\|b`),
          cell(2, 2, String.raw`plain \ slash`),
        ]),
      ],
    });
    const lines = workbookToMarkdown(workbook).split('\n');
    assert.ok(
      lines.includes(String.raw`| a\\\|b | plain \ slash |`),
      'the backslash is doubled, then the pipe is escaped',
    );
  });

  it('escapes rules and list markers as well', () => {
    const workbook = buildWorkbookModel('x.xlsx', {
      sheets: [sheet([cell(1, 1, '---\n- item\n1. step\n***')], { name: 'N' })],
    });
    const escaped = [
      String.raw`\---`,
      String.raw`\- item`,
      String.raw`1\. step`,
      String.raw`\***`,
    ].join('\n');
    assert.ok(workbookToMarkdown(workbook).includes(escaped));
  });

  it('escapes list items the same way', () => {
    const workbook = buildWorkbookModel('x.xlsx', {
      sheets: [
        sheet([cell(1, 1, '- child'), cell(2, 1, '# note')], { name: 'L' }),
      ],
    });
    assert.ok(
      workbookToMarkdown(workbook).includes(
        [String.raw`- \- child`, String.raw`- \# note`].join('\n'),
      ),
    );
  });

  it('escapes text that would change the Markdown structure', () => {
    const workbook = buildWorkbookModel('x.xlsx', {
      sheets: [
        sheet([cell(1, 1, '# Not a heading\n```\n> quote\nplain')], {
          name: 'Notes',
        }),
      ],
    });
    assert.match(
      workbookToMarkdown(workbook),
      /### Notes!A1\n\n\\# Not a heading\n\\```\n\\> quote\nplain\n$/,
    );
  });
});
