/** A rectangle of cells; rows and columns are 1-based and inclusive. */
export interface CellRange {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

const A_CODE = 'A'.charCodeAt(0);

/** 1 -> `A`, 27 -> `AA`. */
export const columnLetters = (column: number): string => {
  let rest = column;
  let letters = '';
  while (rest > 0) {
    const remainder = (rest - 1) % 26;
    letters = String.fromCharCode(A_CODE + remainder) + letters;
    rest = Math.floor((rest - 1) / 26);
  }
  return letters;
};

/** `A` -> 1, `AA` -> 27. */
export const columnNumber = (letters: string): number =>
  [...letters.toUpperCase()].reduce(
    (total, letter) => total * 26 + (letter.charCodeAt(0) - A_CODE + 1),
    0,
  );

/** (1, 1) -> `A1`. */
export const cellAddress = (row: number, column: number): string =>
  `${columnLetters(column)}${row}`;

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;

/** Parses `A1` / `$A$1` into row and column. */
export const parseCellAddress = (
  address: string,
): { readonly row: number; readonly column: number } | undefined => {
  const match = CELL.exec(address.trim());
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return { column: columnNumber(match[1]), row: Number(match[2]) };
};

/** Parses `A1` or `A1:C3` into a rectangle. */
export const parseRange = (text: string): CellRange | undefined => {
  const [first, second, ...rest] = text.split(':');
  if (first === undefined || rest.length > 0) {
    return undefined;
  }
  const start = parseCellAddress(first);
  const end = second === undefined ? start : parseCellAddress(second);
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return {
    bottom: Math.max(start.row, end.row),
    left: Math.min(start.column, end.column),
    right: Math.max(start.column, end.column),
    top: Math.min(start.row, end.row),
  };
};

/** Formats a rectangle as `A1:C3`, or `A1` for a single cell. */
export const formatRange = (range: CellRange): string => {
  const start = cellAddress(range.top, range.left);
  const end = cellAddress(range.bottom, range.right);
  return start === end ? start : `${start}:${end}`;
};

const PLAIN_SHEET_NAME = /^[^\s'!:\\/?*[\]]+$/u;

/**
 * `Sheet1` stays as is; names with spaces or symbols, names starting with a
 * digit and names that look like a cell address (`A1`) are quoted.
 */
export const quoteSheetName = (name: string): string =>
  PLAIN_SHEET_NAME.test(name) && !/^\d/.test(name) && !CELL.test(name)
    ? name
    : `'${name.replaceAll("'", "''")}'`;

/** A citation such as `Sheet1!A1:C3` or `'My Sheet'!B2`. */
export const reference = (sheet: string, range: CellRange): string =>
  `${quoteSheetName(sheet)}!${formatRange(range)}`;
