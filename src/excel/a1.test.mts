import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cellAddress,
  columnLetters,
  columnNumber,
  formatRange,
  parseCellAddress,
  parseRange,
  quoteSheetName,
  reference,
} from './a1.mts';

describe('column letters', () => {
  it('converts both ways across the single/double/triple letter boundaries', () => {
    const cases: ReadonlyArray<[number, string]> = [
      [1, 'A'],
      [26, 'Z'],
      [27, 'AA'],
      [52, 'AZ'],
      [53, 'BA'],
      [702, 'ZZ'],
      [703, 'AAA'],
      [16384, 'XFD'],
    ];
    for (const [number, letters] of cases) {
      assert.equal(columnLetters(number), letters);
      assert.equal(columnNumber(letters), number);
    }
  });

  it('reads lowercase letters', () => {
    assert.equal(columnNumber('ab'), 28);
  });
});

describe('addresses and ranges', () => {
  it('formats and parses a cell address', () => {
    assert.equal(cellAddress(3, 28), 'AB3');
    assert.deepEqual(parseCellAddress('AB3'), { column: 28, row: 3 });
    assert.deepEqual(parseCellAddress('$B$12'), { column: 2, row: 12 });
    assert.equal(parseCellAddress('3AB'), undefined);
    assert.equal(parseCellAddress(''), undefined);
  });

  it('parses ranges and normalizes reversed corners', () => {
    assert.deepEqual(parseRange('A1:C3'), {
      bottom: 3,
      left: 1,
      right: 3,
      top: 1,
    });
    assert.deepEqual(parseRange('C3:A1'), {
      bottom: 3,
      left: 1,
      right: 3,
      top: 1,
    });
    assert.deepEqual(parseRange('B2'), {
      bottom: 2,
      left: 2,
      right: 2,
      top: 2,
    });
    assert.equal(parseRange('A1:B2:C3'), undefined);
    assert.equal(parseRange('nope'), undefined);
  });

  it('formats a range, collapsing a single cell', () => {
    assert.equal(
      formatRange({ bottom: 3, left: 1, right: 3, top: 1 }),
      'A1:C3',
    );
    assert.equal(formatRange({ bottom: 2, left: 2, right: 2, top: 2 }), 'B2');
  });
});

describe('sheet references', () => {
  it('quotes names that need it and doubles embedded quotes', () => {
    assert.equal(quoteSheetName('Sheet1'), 'Sheet1');
    assert.equal(quoteSheetName('My Sheet'), "'My Sheet'");
    assert.equal(quoteSheetName("Tom's"), "'Tom''s'");
    assert.equal(quoteSheetName('設計'), '設計');
    assert.equal(quoteSheetName('2024'), "'2024'");
    assert.equal(quoteSheetName('A1'), "'A1'");
    assert.equal(quoteSheetName('画面 一覧'), "'画面 一覧'");
  });

  it('builds a citation', () => {
    assert.equal(
      reference('My Sheet', { bottom: 20, left: 1, right: 6, top: 1 }),
      "'My Sheet'!A1:F20",
    );
  });
});
