import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { tempDir } from '../shared/temp.mts';
import { convertWorkbookBytes, convertWorkbookFile } from './convert.mts';

/** Builds an .xlsx in memory so no binary fixtures are committed. */
const makeWorkbook = async (
  fill: (workbook: ExcelJS.Workbook) => void,
): Promise<Uint8Array> => {
  const workbook = new ExcelJS.Workbook();
  fill(workbook);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
};

const convert = async (
  fill: (workbook: ExcelJS.Workbook) => void,
  options?: { includeHidden?: boolean },
) => {
  const result = await convertWorkbookBytes(
    await makeWorkbook(fill),
    'design.xlsx',
    options,
  );
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  return result.value;
};

describe('convertWorkbookBytes', () => {
  it('converts a simple table with Japanese text', async () => {
    const { markdown, workbook } = await convert((wb) => {
      const sheet = wb.addWorksheet('画面一覧');
      sheet.addRow(['No', '画面名', '備考']);
      sheet.addRow([1, 'ログイン', '認証画面']);
      sheet.addRow([2, 'トップ', '']);
    });
    assert.equal(
      markdown,
      [
        '# design.xlsx',
        '',
        '## 画面一覧',
        '',
        '### 画面一覧!A1:C3',
        '',
        '| No | 画面名 | 備考 |',
        '| --- | --- | --- |',
        '| 1 | ログイン | 認証画面 |',
        '| 2 | トップ |  |',
        '',
      ].join('\n'),
    );
    assert.equal(workbook.sheets[0]?.used, 'A1:C3');
  });

  it('handles merged headers and vertical merges', async () => {
    const { workbook } = await convert((wb) => {
      const sheet = wb.addWorksheet('Spec');
      sheet.addRow(['Table definition']);
      sheet.addRow(['Group', 'Item', 'Type']);
      sheet.addRow(['Key', 'id', 'int']);
      sheet.addRow([null, 'code', 'text']);
      sheet.addRow(['Other', 'memo', 'text']);
      sheet.mergeCells('A1:C1');
      sheet.mergeCells('A3:A4');
    });
    const sheet = workbook.sheets[0];
    assert.deepEqual(sheet?.merges, ['A1:C1', 'A3:A4']);
    assert.deepEqual(sheet?.blocks[0]?.rows, [['Table definition']]);
    assert.deepEqual(sheet?.blocks[1]?.rows, [
      ['Group', 'Item', 'Type'],
      ['Key', 'id', 'int'],
      ['Key', 'code', 'text'],
      ['Other', 'memo', 'text'],
    ]);
    assert.equal(sheet?.cells.find((c) => c.address === 'A1')?.merged, 'A1:C1');
    assert.equal(
      sheet?.cells.some((c) => c.address === 'B1'),
      false,
      'covered cells hold no value',
    );
  });

  it('splits a sheet into blocks and cites each range', async () => {
    const { workbook } = await convert((wb) => {
      const sheet = wb.addWorksheet('Layout');
      sheet.getCell('A1').value = 'Heading';
      sheet.getCell('A3').value = 'k1';
      sheet.getCell('B3').value = 'v1';
      sheet.getCell('A4').value = 'k2';
      sheet.getCell('B4').value = 'v2';
      sheet.getCell('E3').value = 'side note';
    });
    assert.deepEqual(
      workbook.sheets[0]?.blocks.map((b) => [b.ref, b.kind]),
      [
        ['Layout!A1', 'paragraph'],
        ['Layout!A3:B4', 'table'],
        ['Layout!E3', 'paragraph'],
      ],
    );
  });

  it('shows formula results, falls back to the formula, and keeps both in JSON', async () => {
    const { workbook } = await convert((wb) => {
      const sheet = wb.addWorksheet('Calc');
      sheet.getCell('A1').value = 2;
      sheet.getCell('A2').value = 3;
      sheet.getCell('A3').value = { formula: 'SUM(A1:A2)', result: 5 };
      sheet.getCell('A4').value = { formula: 'A1*A2' };
    });
    const cells = workbook.sheets[0]?.cells;
    assert.deepEqual(
      cells?.map((c) => [c.address, c.text, c.formula]),
      [
        ['A1', '2', undefined],
        ['A2', '3', undefined],
        ['A3', '5', 'SUM(A1:A2)'],
        ['A4', '=A1*A2', 'A1*A2'],
      ],
    );
  });

  it('flattens rich text and renders links and notes', async () => {
    const { markdown, workbook } = await convert((wb) => {
      const sheet = wb.addWorksheet('Docs');
      sheet.getCell('A1').value = {
        richText: [
          { text: 'Bold ' },
          { font: { italic: true }, text: 'and plain' },
        ],
      };
      sheet.getCell('B1').value = {
        hyperlink: 'https://example.com/a',
        text: 'Spec',
      };
      sheet.getCell('A2').value = 'Limit';
      sheet.getCell('A2').note = 'agreed with the client';
      sheet.getCell('B2').value = 10;
    });
    assert.equal(workbook.sheets[0]?.cells[0]?.text, 'Bold and plain');
    assert.equal(
      workbook.sheets[0]?.cells[1]?.hyperlink,
      'https://example.com/a',
    );
    assert.match(markdown, /\| \[Spec\]\(https:\/\/example\.com\/a\) \|/);
    assert.match(
      markdown,
      /\| Limit \[note: agreed with the client\] \| 10 \|/,
    );
  });

  it('writes dates as ISO text, percentages as percentages, booleans and errors as text', async () => {
    const { workbook } = await convert((wb) => {
      const sheet = wb.addWorksheet('Types');
      sheet.getCell('A1').value = new Date(Date.UTC(2026, 0, 5));
      sheet.getCell('A2').value = new Date(Date.UTC(2026, 0, 5, 13, 30, 0));
      const percent = sheet.getCell('A3');
      percent.value = 0.256;
      percent.numFmt = '0.0%';
      sheet.getCell('A4').value = true;
      sheet.getCell('A5').value = { error: '#DIV/0!' };
      sheet.getCell('A6').value = 0.1 + 0.2;
    });
    assert.deepEqual(
      workbook.sheets[0]?.cells.map((c) => [c.kind, c.text]),
      [
        ['date', '2026-01-05'],
        ['date', '2026-01-05T13:30:00'],
        ['number', '25.6%'],
        ['boolean', 'TRUE'],
        ['error', '#DIV/0!'],
        ['number', '0.3'],
      ],
    );
  });

  it('shows zero-padded identifiers and fixed decimals as the sheet displays them', async () => {
    const { workbook } = await convert((wb) => {
      const sheet = wb.addWorksheet('Fmt');
      const id = sheet.getCell('A1');
      id.value = 7;
      id.numFmt = '0000';
      const price = sheet.getCell('A2');
      price.value = 1.5;
      price.numFmt = '0.00';
      const negative = sheet.getCell('A3');
      negative.value = -3;
      negative.numFmt = '000';
    });
    assert.deepEqual(
      workbook.sheets[0]?.cells.map((c) => c.text),
      ['0007', '1.50', '-003'],
    );
  });

  it('turns the cached date result of a formula into an ISO date', async () => {
    const serial = (Date.UTC(2026, 0, 5) - Date.UTC(1899, 11, 30)) / 86_400_000;
    const { workbook } = await convert((wb) => {
      const cell = wb.addWorksheet('F').getCell('A1');
      cell.value = { formula: 'DATE(2026,1,5)', result: serial };
      cell.numFmt = 'yyyy/mm/dd';
    });
    assert.equal(workbook.sheets[0]?.cells[0]?.text, '2026-01-05');
  });

  it('keeps a note that sits on a cell without a value', async () => {
    const { markdown } = await convert((wb) => {
      const sheet = wb.addWorksheet('N');
      sheet.addRow(['Limit', 10]);
      // A styled empty cell is written to the file, as Excel does for a
      // cell that only carries a note.
      sheet.getCell('A2').font = { bold: true };
      sheet.getCell('A2').note = 'agreed with the client';
      sheet.getCell('B2').value = 20;
    });
    assert.match(markdown, /\[note: agreed with the client\] \| 20 \|/);
  });

  it('leaves hidden sheets, rows and columns out unless asked', async () => {
    const fill = (wb: ExcelJS.Workbook): void => {
      const visible = wb.addWorksheet('Visible');
      visible.addRow(['a', 'hidden col', 'c']);
      visible.addRow(['hidden row', 'x', 'y']);
      visible.addRow(['d', 'e', 'f']);
      visible.getColumn(2).hidden = true;
      visible.getRow(2).hidden = true;
      wb.addWorksheet('Internal', { state: 'hidden' }).addRow(['secret']);
    };

    const normal = await convert(fill);
    assert.deepEqual(normal.workbook.sheets[0]?.blocks[0]?.rows, [
      ['a', 'c'],
      ['d', 'f'],
    ]);
    assert.deepEqual(normal.workbook.sheets[1]?.cells, []);
    assert.doesNotMatch(normal.markdown, /secret|hidden/);

    const everything = await convert(fill, { includeHidden: true });
    assert.match(everything.markdown, /secret/);
    assert.match(everything.markdown, /hidden col/);
    assert.equal(everything.workbook.sheets[1]?.state, 'hidden');
  });

  it('quotes sheet names that need it in citations', async () => {
    const { workbook } = await convert((wb) => {
      wb.addWorksheet('Screen list').addRow(['x', 'y']);
    });
    assert.equal(workbook.sheets[0]?.blocks[0]?.ref, "'Screen list'!A1:B1");
  });

  it('survives a workbook without any content', async () => {
    const { markdown, workbook } = await convert((wb) => {
      wb.addWorksheet('Blank');
    });
    assert.equal(markdown, '# design.xlsx\n');
    assert.equal(workbook.sheets[0]?.used, undefined);
  });
});

describe('convertWorkbookBytes failures', () => {
  it('reports legacy or encrypted files as unsupported', async () => {
    const ole2 = Uint8Array.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0,
    ]);
    const result = await convertWorkbookBytes(ole2, 'old.xls');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, 'unsupported');
  });

  it('reports non-workbooks and truncated files as corrupt', async () => {
    const text = await convertWorkbookBytes(
      new TextEncoder().encode('hello'),
      'a.xlsx',
    );
    assert.equal(!text.ok && text.error.code, 'corrupt');

    const empty = await convertWorkbookBytes(new Uint8Array(), 'empty.xlsx');
    assert.equal(!empty.ok && empty.error.code, 'corrupt');

    const whole = await makeWorkbook((wb) =>
      wb.addWorksheet('S').addRow(['x']),
    );
    const truncated = await convertWorkbookBytes(
      whole.slice(0, 60),
      'cut.xlsx',
    );
    assert.equal(!truncated.ok && truncated.error.code, 'corrupt');
    assert.match(!truncated.ok ? truncated.error.message : '', /cut\.xlsx/);
  });
});

describe('convertWorkbookFile', () => {
  it('reads a file from disk and names the source after the file', async (t) => {
    const dir = await tempDir(t);
    const file = join(dir, 'basic-design.xlsx');
    await writeFile(
      file,
      await makeWorkbook((wb) => wb.addWorksheet('S').addRow(['x', 'y'])),
    );
    const result = await convertWorkbookFile(file);
    assert.ok(result.ok);
    assert.equal(result.value.workbook.source, 'basic-design.xlsx');
  });

  it('returns an io failure for a missing file instead of throwing', async (t) => {
    const dir = await tempDir(t);
    const result = await convertWorkbookFile(join(dir, 'missing.xlsx'));
    assert.equal(!result.ok && result.error.code, 'io');
  });
});
