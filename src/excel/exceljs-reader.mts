import ExcelJS from 'exceljs';
import type {
  CellKind,
  RawCell,
  RawSheet,
  RawWorkbook,
  WorkbookReader,
} from './types.mts';

const dateText = (date: Date): string => {
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const iso = date.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19);
};

/** What a number format displays: a calendar date, a time of day, or a plain number. */
export type DateKind = 'date' | 'time';

/**
 * Tells date formats (\`yyyy/mm/dd\`, era formats, month names) from time-only
 * formats (\`h:mm\`, elapsed \`[h]:mm\`). Quoted text and escaped characters are
 * ignored.
 */
export const dateFormatKind = (
  numFmt: string | undefined,
): DateKind | undefined => {
  if (numFmt === undefined) {
    return undefined;
  }
  if (/^general/i.test(numFmt.trim())) {
    return undefined;
  }
  const bare = numFmt
    .replace(/"[^"]*"/g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '')
    .replace(/\\./g, '');
  // Year, day and era codes make a date; hour and second codes a time; a month
  // code alone (mmm) a date. cspell:disable-next-line
  if (/[ydg]/i.test(bare)) {
    return 'date';
  }
  if (/[hs]/i.test(bare) || /\[m+\]/i.test(bare)) {
    return 'time';
  }
  return /m/i.test(bare) ? 'date' : undefined;
};

/**
 * An Excel serial day number as a Date, in UTC. Excel's 1900 system counts a
 * 29 February 1900 that never existed, which shifts the first 59 days; the
 * 1904 system starts four years and a day later.
 */
export const serialToDate = (serial: number, date1904 = false): Date => {
  const days = date1904
    ? serial - 24107
    : serial < 60
      ? serial - 25568
      : serial - 25569;
  return new Date(Math.round(days * 86_400_000));
};

/**
 * What a date value shows. ExcelJS turns serial numbers of date-formatted
 * cells into Dates; a time-only format needs the time back, not a calendar day.
 */
const dateValueText = (
  date: Date,
  numFmt: string | undefined,
  date1904: boolean,
): string => {
  if (numFmt !== undefined && dateFormatKind(numFmt) === 'time') {
    const serial = date.getTime() / 86_400_000 + (date1904 ? 24107 : 25569);
    return timeText(serial, numFmt);
  }
  return dateText(date);
};

/**
 * The time a serial shows under a time format. The fields are the ones the
 * format asks for, in its order: hours (`h`), minutes (`m`) and seconds (`s`).
 * A bracketed unit (`[h]`, `[m]`, `[s]`) counts elapsed time and has no upper
 * limit; the other units show what is left after it. `AM/PM` and `A/P` switch
 * the hours to the 12-hour clock. Every field is padded to as many digits as
 * its letters in the format (`h` 9, `hh` 09).
 */
const timeText = (serial: number, numFmt: string): string => {
  const format = (numFmt.replace(/"[^"]*"/g, '').split(';')[0] ?? '').trim();
  const total = Math.round(serial * 86_400);
  const meridiem = /AM\/PM|A\/P/i.exec(format);
  const clockHours = Math.floor(total / 3600) % 24;

  const fields: string[] = [];
  for (const token of format
    .replace(/AM\/PM|A\/P/gi, '')
    .matchAll(/(\[)?(h+|m+|s+)\]?/gi)) {
    const unit = (token[2] ?? '').toLowerCase();
    const elapsed = token[1] !== undefined;
    let value: number;
    if (unit.startsWith('h')) {
      value = elapsed
        ? Math.floor(total / 3600)
        : meridiem === null
          ? clockHours
          : clockHours % 12 || 12;
    } else if (unit.startsWith('m')) {
      value = elapsed
        ? Math.floor(total / 60)
        : Math.floor((total % 3600) / 60);
    } else {
      value = elapsed ? total : total % 60;
    }
    fields.push(String(value).padStart(unit.length, '0'));
  }

  const clock = fields.join(':');
  if (meridiem === null) {
    return clock;
  }
  const mark = clockHours < 12 ? 'AM' : 'PM';
  // `A/P` shows one letter, `AM/PM` two.
  return `${clock} ${meridiem[0].length === 3 ? mark.slice(0, 1) : mark}`;
};

/**
 * The text a cell shows for a number. Percent formats show 25.6%, identifiers
 * with a zero-padded format show 0001, and fixed decimals keep their trailing
 * zeros (1.50); everything else stays plain.
 */
const numberText = (value: number, numFmt: string | undefined): string => {
  const format = numFmt?.split(';')[0] ?? '';
  if (format.includes('%')) {
    const decimals = /\.(0+)%/.exec(format)?.[1]?.length ?? 0;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  if (/^0+$/.test(format)) {
    const sign = value < 0 ? '-' : '';
    return `${sign}${String(Math.round(Math.abs(value))).padStart(format.length, '0')}`;
  }
  const fixed = /^0\.(0+)$/.exec(format);
  if (fixed?.[1] !== undefined) {
    return value.toFixed(fixed[1].length);
  }
  // Drop binary noise such as 0.30000000000000004.
  return String(Number(value.toPrecision(15)));
};

const resultText = (
  result: unknown,
  numFmt: string | undefined,
  date1904 = false,
): string | undefined => {
  if (result === undefined || result === null) {
    return undefined;
  }
  if (typeof result === 'number') {
    // A cached date or time result is stored as a serial number.
    const kind = dateFormatKind(numFmt);
    if (kind === 'date') {
      return dateText(serialToDate(result, date1904));
    }
    return kind === 'time' && numFmt !== undefined
      ? timeText(result, numFmt)
      : numberText(result, numFmt);
  }
  if (typeof result === 'boolean') {
    return result ? 'TRUE' : 'FALSE';
  }
  if (result instanceof Date) {
    return dateValueText(result, numFmt, date1904);
  }
  if (typeof result === 'object' && 'error' in result) {
    return String((result as { error: unknown }).error);
  }
  return String(result);
};

const noteText = (
  note: string | ExcelJS.Comment | undefined,
): string | undefined => {
  const text =
    typeof note === 'string'
      ? note
      : (note?.texts ?? []).map((part) => part.text).join('');
  return text.trim() === '' ? undefined : text.trim();
};

const richText = (value: ExcelJS.CellRichTextValue): string =>
  value.richText.map((part) => part.text).join('');

const toRawCell = (
  cell: ExcelJS.Cell,
  row: number,
  column: number,
  date1904: boolean,
): RawCell | undefined => {
  const note = noteText(cell.note);
  const make = (
    kind: CellKind,
    text: string,
    extra: { formula?: string; hyperlink?: string } = {},
  ): RawCell => ({
    column,
    kind,
    row,
    text,
    ...extra,
    ...(note === undefined ? {} : { note }),
  });
  const value = cell.value;

  switch (cell.type) {
    case ExcelJS.ValueType.Number:
      return make('number', numberText(value as number, cell.numFmt));
    case ExcelJS.ValueType.String:
    case ExcelJS.ValueType.SharedString:
      return make('text', String(value));
    case ExcelJS.ValueType.RichText:
      return make('text', richText(value as ExcelJS.CellRichTextValue));
    case ExcelJS.ValueType.Date:
      return make('date', dateValueText(value as Date, cell.numFmt, date1904));
    case ExcelJS.ValueType.Boolean:
      return make('boolean', value === true ? 'TRUE' : 'FALSE');
    case ExcelJS.ValueType.Error:
      return make('error', String((value as ExcelJS.CellErrorValue).error));
    case ExcelJS.ValueType.Hyperlink: {
      const link = value as ExcelJS.CellHyperlinkValue;
      return make('text', link.text, { hyperlink: link.hyperlink });
    }
    case ExcelJS.ValueType.Formula: {
      const formula = cell.formula;
      const formulaValue = value as ExcelJS.CellFormulaValue;
      const shown = resultText(
        formulaValue.result,
        cell.numFmt,
        formulaValue.date1904 === true || date1904,
      );
      // A formula that was never calculated has no cached result: show it.
      return make('formula', shown ?? `=${formula}`, { formula });
    }
    case ExcelJS.ValueType.Null:
      // A cell that holds only a note still carries information.
      return note === undefined ? undefined : make('text', '');
    default:
      // The covered cells of a merge: their master holds the value.
      return undefined;
  }
};

const readSheet = (sheet: ExcelJS.Worksheet, date1904: boolean): RawSheet => {
  const cells: RawCell[] = [];
  const hiddenRows: number[] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (row.hidden) {
      hiddenRows.push(rowNumber);
    }
    // Empty cells are visited too, because a note can sit on a cell without a value.
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      const raw = toRawCell(cell, rowNumber, columnNumber, date1904);
      if (raw !== undefined) {
        cells.push(raw);
      }
    });
  });
  const hiddenColumns: number[] = [];
  for (let column = 1; column <= sheet.columnCount; column++) {
    if (sheet.getColumn(column).hidden) {
      hiddenColumns.push(column);
    }
  }
  return {
    cells,
    hiddenColumns,
    hiddenRows,
    merges: [...sheet.model.merges],
    name: sheet.name,
    state: sheet.state,
  };
};

/** Reads `.xlsx` workbooks with ExcelJS. */
export const exceljsReader: WorkbookReader = {
  async read(data: Uint8Array): Promise<RawWorkbook> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength) as never,
    );
    // The date system belongs to the workbook, and so does the epoch that
    // ExcelJS used to turn serial numbers into dates.
    const date1904 = workbook.properties.date1904 === true;
    return {
      sheets: workbook.worksheets.map((sheet) => readSheet(sheet, date1904)),
    };
  },
};
