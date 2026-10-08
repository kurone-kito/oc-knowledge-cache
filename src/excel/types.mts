/** How the value of a cell was stored in the workbook. */
export type CellKind =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'formula'
  | 'error';

export type SheetState = 'visible' | 'hidden' | 'veryHidden';

/**
 * A non-empty cell as read from a workbook, independent of the spreadsheet
 * library. Values are already resolved to display text.
 */
export interface RawCell {
  /** 1-based. */
  readonly row: number;
  /** 1-based. */
  readonly column: number;
  readonly text: string;
  readonly kind: CellKind;
  readonly formula?: string | undefined;
  readonly hyperlink?: string | undefined;
  readonly note?: string | undefined;
}

export interface RawSheet {
  readonly name: string;
  readonly state: SheetState;
  /** Master cells only: cells covered by a merge hold no value of their own. */
  readonly cells: readonly RawCell[];
  /** Merged ranges in A1 notation, e.g. `A1:C1`. */
  readonly merges: readonly string[];
  readonly hiddenRows: readonly number[];
  readonly hiddenColumns: readonly number[];
}

export interface RawWorkbook {
  readonly sheets: readonly RawSheet[];
}

/** Reads the bytes of a workbook; the one place that knows the library. */
export interface WorkbookReader {
  read(data: Uint8Array): Promise<RawWorkbook>;
}

export interface CellModel {
  /** A1 address, e.g. `B7`. */
  readonly address: string;
  readonly row: number;
  readonly column: number;
  readonly text: string;
  readonly kind: CellKind;
  readonly formula?: string;
  readonly hyperlink?: string;
  readonly note?: string;
  /** Range covered when this cell is the master of a merge. */
  readonly merged?: string;
  /** Set only when hidden content was requested. */
  readonly hidden?: true;
}

export type BlockKind = 'table' | 'list' | 'paragraph';

/** A rectangular region of related cells, the unit of retrieval. */
export interface BlockModel {
  /** Citation such as `Sheet1!A1:F20`. */
  readonly ref: string;
  /** A1 range without the sheet name. */
  readonly range: string;
  readonly kind: BlockKind;
  /** Rendered text, one inner array per row. */
  readonly rows: readonly (readonly string[])[];
}

export interface SheetModel {
  readonly name: string;
  readonly state: SheetState;
  /** Bounding box of all content, or undefined for an empty sheet. */
  readonly used: string | undefined;
  readonly merges: readonly string[];
  readonly cells: readonly CellModel[];
  readonly blocks: readonly BlockModel[];
}

export interface WorkbookModel {
  /** File name or path the workbook came from. */
  readonly source: string;
  readonly sheets: readonly SheetModel[];
}
