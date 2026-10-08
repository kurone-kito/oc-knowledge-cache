import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { convertWorkbookBytes } from './convert.mts';
import { dateFormatKind, serialToDate } from './exceljs-reader.mts';

const iso = (date: Date): string => date.toISOString().slice(0, 10);

describe('serialToDate', () => {
  it('converts serial days of the 1900 system', () => {
    assert.equal(iso(serialToDate(46027)), '2026-01-05');
    assert.equal(iso(serialToDate(61)), '1900-03-01');
    assert.equal(iso(serialToDate(1)), '1900-01-01');
  });

  it('accounts for the leap day that Excel invented in 1900', () => {
    assert.equal(iso(serialToDate(59)), '1900-02-28');
  });

  it('converts serial days of the 1904 system', () => {
    assert.equal(iso(serialToDate(44565, true)), '2026-01-05');
    assert.equal(iso(serialToDate(0, true)), '1904-01-01');
  });

  it('keeps the time of day', () => {
    assert.equal(
      serialToDate(46027.5).toISOString(),
      '2026-01-05T12:00:00.000Z',
    );
  });
});

describe('dateFormatKind', () => {
  it('knows dates, times and plain numbers', () => {
    const cases: ReadonlyArray<
      [string | undefined, 'date' | 'time' | undefined]
    > = [
      ['yyyy/mm/dd', 'date'],
      ['yyyy-mm-dd hh:mm', 'date'],
      ['g"/"yy"年"m"月"d"日"', 'date'],
      ['mmm', 'date'],
      ['h:mm', 'time'],
      ['h:mm:ss AM/PM', 'time'],
      ['[h]:mm', 'time'],
      ['General', undefined],
      ['0.00', undefined],
      ['#,##0', undefined],
      ['"Day "0', undefined],
      ['0.00E+00', undefined],
      [undefined, undefined],
    ];
    for (const [format, expected] of cases) {
      assert.equal(dateFormatKind(format), expected, String(format));
    }
  });
});

describe('cached formula results', () => {
  const textOf = async (
    result: number,
    numFmt: string,
    date1904 = false,
  ): Promise<string | undefined> => {
    const workbook = new ExcelJS.Workbook();
    workbook.properties.date1904 = date1904;
    const cell = workbook.addWorksheet('F').getCell('A1');
    cell.value = { date1904, formula: 'NOW()', result };
    cell.numFmt = numFmt;
    const converted = await convertWorkbookBytes(
      new Uint8Array(await workbook.xlsx.writeBuffer()),
      'f.xlsx',
    );
    return converted.ok
      ? converted.value.workbook.sheets[0]?.cells[0]?.text
      : undefined;
  };

  it('shows a time of day as a time, not as a date', async () => {
    assert.equal(await textOf(0.5, 'h:mm'), '12:00');
    assert.equal(await textOf(0.75, 'h:mm:ss'), '18:00:00');
  });

  it('follows the letters of the format: padding, AM/PM, elapsed minutes and seconds', async () => {
    const nineOhFive = (9 * 60 + 5) / 1440;
    assert.equal(await textOf(nineOhFive, 'h:mm'), '9:05');
    assert.equal(await textOf(nineOhFive, 'hh:mm'), '09:05');
    const half = (13 * 60 + 30) / 1440;
    assert.equal(await textOf(half, 'h:mm AM/PM'), '1:30 PM');
    assert.equal(await textOf(half, 'h:mm A/P'), '1:30 P');
    assert.equal(await textOf(0, 'h:mm AM/PM'), '12:00 AM');
    // Only the fields that the format has, in its order.
    const nineFiveSeven = (9 * 3600 + 5 * 60 + 7) / 86_400;
    assert.equal(await textOf(nineFiveSeven, 'h'), '9');
    assert.equal(await textOf(nineFiveSeven, 'hh'), '09');
    assert.equal(await textOf(nineFiveSeven, 'h:mm:ss'), '9:05:07');
    assert.equal(await textOf(nineFiveSeven, 'mm:ss'), '05:07');
    assert.equal(await textOf(nineFiveSeven, 'h:m'), '9:5');
    assert.equal(await textOf(90 / 1440, '[m]:ss'), '90:00');
    assert.equal(await textOf(86 / 86_400, '[s]'), '86');
  });

  it('shows elapsed hours beyond a day', async () => {
    assert.equal(await textOf(1.5, '[h]:mm'), '36:00');
  });

  it('still shows dates, in either date system', async () => {
    assert.equal(await textOf(46027, 'yyyy/mm/dd'), '2026-01-05');
    assert.equal(await textOf(44565, 'yyyy/mm/dd', true), '2026-01-05');
  });

  it('shows an elapsed-time format of a plain date cell in a 1904 workbook as time', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.properties.date1904 = true;
    const sheet = workbook.addWorksheet('T');
    sheet.getCell('A1').value = new Date(Date.UTC(1904, 0, 1, 12, 0, 0));
    sheet.getCell('A1').numFmt = '[h]:mm';
    sheet.getCell('A2').value = new Date(Date.UTC(1904, 0, 2, 12, 0, 0));
    sheet.getCell('A2').numFmt = '[h]:mm';
    const converted = await convertWorkbookBytes(
      new Uint8Array(await workbook.xlsx.writeBuffer()),
      't.xlsx',
    );
    assert.ok(converted.ok);
    const texts = converted.ok
      ? converted.value.workbook.sheets[0]?.cells.map((cell) => cell.text)
      : [];
    assert.deepEqual(texts, ['12:00', '36:00']);
  });
});
