import {
  type CellRange,
  cellAddress,
  formatRange,
  parseRange,
  reference,
} from './a1.mts';
import type {
  BlockKind,
  BlockModel,
  CellModel,
  RawCell,
  RawSheet,
  RawWorkbook,
  SheetModel,
  WorkbookModel,
} from './types.mts';

export interface BuildOptions {
  /** Include hidden sheets, rows and columns (default: leave them out). */
  readonly includeHidden?: boolean;
}

interface Position {
  readonly row: number;
  readonly column: number;
}

const key = (row: number, column: number): string => `${row},${column}`;

const byNumber = (a: number, b: number): number => a - b;

const minOf = (values: readonly number[]): number =>
  values.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);

const maxOf = (values: readonly number[]): number =>
  values.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);

/**
 * Splits numbers into runs without a gap. A gap exists when a row (or
 * column) that is not hidden lies between two neighbours, so hidden lines
 * never split a table.
 */
const runs = (
  values: Iterable<number>,
  hidden: ReadonlySet<number>,
): number[][] => {
  const result: number[][] = [];
  for (const value of [...values].sort(byNumber)) {
    const current = result.at(-1);
    const previous = current?.at(-1);
    let gap = current === undefined || previous === undefined;
    if (previous !== undefined) {
      // Stops at the first visible line, so it runs at most hidden.size + 1 times.
      for (let between = previous + 1; between < value; between++) {
        if (!hidden.has(between)) {
          gap = true;
          break;
        }
      }
    }
    if (gap || current === undefined) {
      result.push([value]);
    } else {
      current.push(value);
    }
  }
  return result;
};

/** Largest merged area (in cells) that block detection walks cell by cell. */
const MAX_MERGED_AREA = 50_000;

const WEB_LINK = /^(?:https?:|mailto:|file:|#)/i;

/**
 * A Markdown link whose label and destination survive their own delimiters:
 * brackets and backslashes in the label are escaped, and a destination loses
 * the characters that would end or split it.
 */
const markdownLink = (label: string, destination: string): string => {
  const escapedLabel = label.replace(/[[\]\\]/g, '\\$&');
  const safeDestination = destination.replace(
    /[()\s<>]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
  return `[${escapedLabel}](${safeDestination})`;
};

/** The text of a cell as it appears in a block: with its link and note. */
const displayText = (cell: RawCell): string => {
  const text = cell.text.trim();
  const linked =
    cell.hyperlink !== undefined && WEB_LINK.test(cell.hyperlink)
      ? markdownLink(text === '' ? cell.hyperlink : text, cell.hyperlink)
      : text;
  if (cell.note === undefined) {
    return linked;
  }
  return linked === ''
    ? `[note: ${cell.note}]`
    : `${linked} [note: ${cell.note}]`;
};

/**
 * A cell has content when it shows text or carries a note, a link or a
 * formula: a formula whose cached result is empty (`=IF(..., "", ...)`) is
 * still the design of the sheet.
 */
const hasContent = (cell: RawCell): boolean =>
  cell.text.trim() !== '' ||
  cell.note !== undefined ||
  cell.formula !== undefined ||
  cell.hyperlink !== undefined;

const emptySheet = (sheet: RawSheet): SheetModel => ({
  blocks: [],
  cells: [],
  merges: [],
  name: sheet.name,
  state: sheet.state,
  used: undefined,
});

const toCellModel = (
  cell: RawCell,
  merged: string | undefined,
  hidden: boolean,
): CellModel => ({
  address: cellAddress(cell.row, cell.column),
  column: cell.column,
  kind: cell.kind,
  row: cell.row,
  text: cell.text,
  ...(cell.formula === undefined ? {} : { formula: cell.formula }),
  ...(cell.hyperlink === undefined ? {} : { hyperlink: cell.hyperlink }),
  ...(cell.note === undefined ? {} : { note: cell.note }),
  ...(merged === undefined ? {} : { merged }),
  ...(hidden ? { hidden: true as const } : {}),
});

/**
 * Builds the text matrix of one region and decides how to present it. Rows at
 * the top that hold a single value above a wider table (a title, usually a
 * merged one) become paragraphs of their own, so the table's first row is its
 * real column header and its columns do not include the title's merged tail.
 */
const toBlocks = (
  sheetName: string,
  range: CellRange,
  rows: readonly number[],
  columns: readonly number[],
  textAt: (row: number, column: number) => string,
): BlockModel[] => {
  const matrix = rows.map((row) =>
    columns.map((column) => textAt(row, column)),
  );

  /** The rows at these indexes without columns and rows that hold no text. */
  const squeeze = (indexes: readonly number[]) => {
    // Columns without any text are spacers or the tail of a horizontal merge.
    const keep = columns.map((_, at) =>
      indexes.some((index) => matrix[index]?.[at] !== ''),
    );
    const keptColumns = columns.filter((_, at) => keep[at]);
    return {
      left: minOf(keptColumns),
      lines: indexes
        .map((index) => ({
          cells: (matrix[index] ?? []).filter((_, at) => keep[at]),
          row: rows[index] as number,
        }))
        .filter(({ cells }) => cells.some((text) => text !== '')),
      right: maxOf(keptColumns),
    };
  };

  const all = squeeze(rows.map((_, index) => index));
  if (all.lines.length === 0) {
    return [];
  }

  const filled = (cells: readonly string[]): number =>
    cells.filter((text) => text !== '').length;
  let titles = 0;
  while (
    titles < all.lines.length - 1 &&
    (all.lines[titles]?.cells.length ?? 0) > 1 &&
    filled(all.lines[titles]?.cells ?? []) === 1
  ) {
    titles++;
  }
  // Only a title when a real table follows it.
  if (!all.lines.slice(titles).some(({ cells }) => filled(cells) > 1)) {
    titles = 0;
  }

  const block = (
    kind: BlockKind,
    blockRange: CellRange,
    cells: readonly (readonly string[])[],
  ): BlockModel => ({
    kind,
    range: formatRange(blockRange),
    ref: reference(sheetName, blockRange),
    rows:
      kind === 'paragraph'
        ? [[cells[0]?.find((text) => text !== '') ?? '']]
        : cells,
  });

  const blocks: BlockModel[] = all.lines
    .slice(0, titles)
    .map((title) =>
      block('paragraph', { ...range, bottom: title.row, top: title.row }, [
        title.cells,
      ]),
    );

  // Without titles the region keeps its full width; with titles the table is
  // measured on its own rows.
  const rest =
    titles === 0
      ? all
      : squeeze(
          rows
            .map((row, index) => ({ index, row }))
            .filter(({ row }) => row >= (all.lines[titles]?.row ?? 0))
            .map(({ index }) => index),
        );
  const firstRow = rest.lines[0]?.row ?? range.top;
  const width = rest.lines[0]?.cells.length ?? 0;
  const kind: BlockKind =
    width > 1 ? 'table' : rest.lines.length === 1 ? 'paragraph' : 'list';
  blocks.push(
    block(
      kind,
      titles === 0
        ? range
        : {
            bottom: range.bottom,
            left: rest.left,
            right: rest.right,
            top: firstRow,
          },
      rest.lines.map(({ cells }) => cells),
    ),
  );
  return blocks;
};

const buildSheet = (sheet: RawSheet, includeHidden: boolean): SheetModel => {
  if (sheet.state !== 'visible' && !includeHidden) {
    return emptySheet(sheet);
  }

  // Hidden lines never split a table, whether or not their content is wanted.
  const rawHiddenRows = new Set(sheet.hiddenRows);
  const rawHiddenColumns = new Set(sheet.hiddenColumns);
  const hiddenRows = includeHidden ? new Set<number>() : rawHiddenRows;
  const hiddenColumns = includeHidden ? new Set<number>() : rawHiddenColumns;
  const isHidden = (row: number, column: number): boolean =>
    hiddenRows.has(row) || hiddenColumns.has(column);

  const visible = sheet.cells.filter(
    (cell) => hasContent(cell) && !isHidden(cell.row, cell.column),
  );
  const cellAt = new Map<string, RawCell>(
    visible.map((cell) => [key(cell.row, cell.column), cell]),
  );
  const merges = sheet.merges.flatMap((text) => {
    const range = parseRange(text);
    return range === undefined ? [] : [range];
  });

  // Positions that carry content: cells with text, and everything that a
  // merge with text covers (so a merged title never splits its table).
  const occupied = new Map<string, Position>(
    visible.map((cell) => [
      key(cell.row, cell.column),
      { column: cell.column, row: cell.row },
    ]),
  );
  const rowspanFill = new Map<string, RawCell>();
  // A merge may span a whole sheet (A1:XFD1048576) although the sheet holds a
  // few cells: its area is limited to the content before it is walked, and a
  // merge that is still huge counts as its first cell only.
  const lastRow = visible.reduce((max, cell) => Math.max(max, cell.row), 0);
  const lastColumn = visible.reduce(
    (max, cell) => Math.max(max, cell.column),
    0,
  );
  for (const wanted of merges) {
    const master = cellAt.get(key(wanted.top, wanted.left));
    if (master === undefined) {
      continue;
    }
    const area = (r: typeof wanted): number =>
      (r.bottom - r.top + 1) * (r.right - r.left + 1);
    let range = wanted;
    if (area(range) > MAX_MERGED_AREA) {
      range = {
        ...wanted,
        bottom: Math.max(wanted.top, Math.min(wanted.bottom, lastRow)),
        right: Math.max(wanted.left, Math.min(wanted.right, lastColumn)),
      };
    }
    if (area(range) > MAX_MERGED_AREA) {
      range = { ...range, bottom: range.top, right: range.left };
    }
    for (let row = range.top; row <= range.bottom; row++) {
      for (let column = range.left; column <= range.right; column++) {
        if (!isHidden(row, column)) {
          occupied.set(key(row, column), { column, row });
        }
      }
      // A vertical span repeats its value in the first column of every row,
      // so each row stays self-contained. Horizontal spans stay empty.
      if (row > range.top && !isHidden(row, range.left)) {
        rowspanFill.set(key(row, range.left), master);
      }
    }
  }

  const textAt = (row: number, column: number): string => {
    const cell =
      cellAt.get(key(row, column)) ?? rowspanFill.get(key(row, column));
    return cell === undefined ? '' : displayText(cell);
  };

  const columnsByRow = new Map<number, number[]>();
  for (const { column, row } of occupied.values()) {
    const columns = columnsByRow.get(row);
    if (columns === undefined) {
      columnsByRow.set(row, [column]);
    } else {
      columns.push(column);
    }
  }

  const blocks: BlockModel[] = [];
  for (const band of runs(columnsByRow.keys(), rawHiddenRows)) {
    const bandColumns = new Set<number>();
    for (const row of band) {
      for (const column of columnsByRow.get(row) ?? []) {
        bandColumns.add(column);
      }
    }
    for (const group of runs(bandColumns, rawHiddenColumns)) {
      const members = new Set(group);
      const rows = band.filter((row) =>
        columnsByRow.get(row)?.some((column) => members.has(column)),
      );
      blocks.push(
        ...toBlocks(
          sheet.name,
          {
            bottom: maxOf(rows),
            left: minOf(group),
            right: maxOf(group),
            top: minOf(rows),
          },
          rows,
          group,
          textAt,
        ),
      );
    }
  }

  const usedRows = [...columnsByRow.keys()];
  const usedColumns = [...occupied.values()].map((p) => p.column);
  const mergeOf = new Map(
    merges.map((range) => [key(range.top, range.left), formatRange(range)]),
  );
  const sheetHidden = sheet.state !== 'visible';

  return {
    blocks,
    cells: sheet.cells
      .filter(hasContent)
      .filter((cell) => !isHidden(cell.row, cell.column))
      .sort((a, b) => a.row - b.row || a.column - b.column)
      .map((cell) =>
        toCellModel(
          cell,
          mergeOf.get(key(cell.row, cell.column)),
          includeHidden &&
            (sheetHidden ||
              rawHiddenRows.has(cell.row) ||
              rawHiddenColumns.has(cell.column)),
        ),
      ),
    merges: merges.map(formatRange),
    name: sheet.name,
    state: sheet.state,
    used:
      usedRows.length === 0
        ? undefined
        : formatRange({
            bottom: maxOf(usedRows),
            left: minOf(usedColumns),
            right: maxOf(usedColumns),
            top: minOf(usedRows),
          }),
  };
};

/** Turns raw cells into sheets of blocks, the unit of retrieval. */
export const buildWorkbookModel = (
  source: string,
  workbook: RawWorkbook,
  options: BuildOptions = {},
): WorkbookModel => ({
  sheets: workbook.sheets.map((sheet) =>
    buildSheet(sheet, options.includeHidden === true),
  ),
  source,
});
