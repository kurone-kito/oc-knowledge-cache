import { blockLines } from '../excel/markdown.mts';
import type { WorkbookModel } from '../excel/types.mts';

export interface ChunkOptions {
  /** Longest chunk in characters, context line included (default 1000). */
  readonly maxChars?: number;
  /**
   * Lines repeated at the start of the next chunk when one block is split
   * over several chunks, in characters (default 100). Neighbouring blocks that
   * each fit stay separate chunks without overlap.
   */
  readonly overlapChars?: number;
}

export interface ChunkMetadata {
  /** Document the chunk came from (file name). */
  readonly source: string;
  /** Sheet name, for workbooks. */
  readonly sheet: string | undefined;
  /** Citations such as `Sheet1!A1:F20`, one per block in the chunk. */
  readonly refs: readonly string[];
  /** Where the chunk sits in the document: file, sheet or headings. */
  readonly headingPath: readonly string[];
}

export interface Chunk {
  readonly text: string;
  readonly metadata: ChunkMetadata;
}

/** A run of related lines; `header` is repeated whenever it is split. */
interface Segment {
  readonly ref: string | undefined;
  readonly header: readonly string[];
  readonly lines: readonly string[];
}

const DEFAULT_MAX_CHARS = 1000;
const DEFAULT_OVERLAP_CHARS = 100;
const MIN_MAX_CHARS = 100;
/** Characters of a chunk, in characters per token, that suit any language. */
const SAFE_CHARS_PER_TOKEN = 0.8;

const BOUNDARY = /[。！？.!?\n、,;； ]/;

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;

/**
 * Splits text that is longer than `max` into pieces of at most `max`
 * characters, preferring sentence and word boundaries and never cutting a
 * surrogate pair.
 */
export const hardSplit = (text: string, max: number): string[] => {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`max must be a positive integer, got ${max}`);
  }
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = max;
    for (let i = max - 1; i >= Math.floor(max * 0.6); i--) {
      if (BOUNDARY.test(rest.charAt(i))) {
        cut = i + 1;
        break;
      }
    }
    if (cut === max && isHighSurrogate(rest.charCodeAt(max - 1))) {
      cut = max - 1;
    }
    if (cut < 1) {
      // A one-character limit cannot hold a surrogate pair; always progress.
      cut = max;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== '') {
    pieces.push(rest);
  }
  return pieces;
};

/** Cells of a Markdown table row; escaped pipes stay inside their cell. */
const rowCells = (row: string): string[] => {
  const cells = row.split(/(?<!\\)\|/);
  if (cells[0]?.trim() === '') {
    cells.shift();
  }
  if (cells.at(-1)?.trim() === '') {
    cells.pop();
  }
  return cells.map((cell) => cell.trim());
};

/** The separator between a column name and its value in a record line. */
const LABEL_SEPARATOR = ': ';

/** Rewrites a table row as one `column: value` line per non-empty cell. */
const asRecord = (columnRow: string, row: string): string[] => {
  const names = rowCells(columnRow);
  return rowCells(row).flatMap((value, index) =>
    value === ''
      ? []
      : [`${names[index] || `column ${index + 1}`}${LABEL_SEPARATOR}${value}`],
  );
};

/** Splits a `label: value` line, repeating the label on every piece. */
const splitLabeled = (entry: string, room: number): string[] => {
  const at = entry.indexOf(LABEL_SEPARATOR);
  const prefix = at < 0 ? '' : entry.slice(0, at + LABEL_SEPARATOR.length);
  const value = entry.slice(prefix.length);
  // A label that leaves almost no room is not worth repeating.
  if (prefix.length > room / 2) {
    return hardSplit(entry, room);
  }
  return hardSplit(value, room - prefix.length).map((piece) => prefix + piece);
};

/**
 * Chunk sizes that fit an embedding model's context window. Without a known
 * context the defaults apply.
 */
export const limitsForContext = (
  contextTokens: number | undefined,
): Required<ChunkOptions> => {
  const maxChars =
    contextTokens === undefined || !Number.isFinite(contextTokens)
      ? DEFAULT_MAX_CHARS
      : Math.max(
          MIN_MAX_CHARS,
          Math.min(
            DEFAULT_MAX_CHARS,
            Math.floor(contextTokens * SAFE_CHARS_PER_TOKEN),
          ),
        );
  return {
    maxChars,
    overlapChars: Math.min(DEFAULT_OVERLAP_CHARS, Math.floor(maxChars / 5)),
  };
};

export interface Limits {
  readonly max: number;
  readonly overlap: number;
}

/**
 * A usable size, in whole characters: NaN and Infinity (which would disable
 * the limit) are not, and a fraction is rounded down.
 */
const finiteOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback;

export const resolveLimits = (options: ChunkOptions): Limits => {
  const max = Math.max(
    MIN_MAX_CHARS,
    finiteOr(options.maxChars, DEFAULT_MAX_CHARS),
  );
  const overlap = Math.min(
    Math.max(0, finiteOr(options.overlapChars, DEFAULT_OVERLAP_CHARS)),
    Math.floor(max / 4),
  );
  return { max, overlap };
};

interface Piece {
  readonly ref: string | undefined;
  readonly lines: readonly string[];
}

const pieceSize = (piece: Piece): number =>
  piece.lines.reduce((sum, line) => sum + line.length, 0) +
  Math.max(0, piece.lines.length - 1);

/** Size of a chunk body made of pieces, separated by blank lines. */
const bodySize = (pieces: readonly Piece[]): number =>
  pieces.reduce((sum, piece) => sum + pieceSize(piece), 0) +
  2 * Math.max(0, pieces.length - 1);

const fitContext = (context: string, max: number): string => {
  const limit = Math.floor(max * 0.4);
  if (context.length <= limit) {
    return context;
  }
  // Never end on the first half of a surrogate pair.
  let end = limit - 1;
  if (end > 0 && isHighSurrogate(context.charCodeAt(end - 1))) {
    end -= 1;
  }
  return `${context.slice(0, end)}…`;
};

/**
 * Packs segments into chunks of at most `max` characters. Small segments share
 * a chunk; a segment that is too large is split by lines, repeating its header
 * (a table keeps its column names) and overlapping neighbours. A line is only
 * cut when it alone does not fit.
 */
const packSegments = (
  segments: readonly Segment[],
  context: string,
  limits: Limits,
): { text: string; refs: string[] }[] => {
  const heading = fitContext(context, limits.max);
  const budget = limits.max - heading.length - 2;
  const chunks: { text: string; refs: string[] }[] = [];
  let current: Piece[] = [];

  const emit = (pieces: readonly Piece[]): void => {
    if (pieces.length === 0) {
      return;
    }
    const body = pieces.map((piece) => piece.lines.join('\n')).join('\n\n');
    chunks.push({
      refs: pieces.flatMap((piece) =>
        piece.ref === undefined ? [] : [piece.ref],
      ),
      text: `${heading}\n\n${body}`,
    });
  };

  for (const segment of segments) {
    const whole: Piece = {
      lines: [...segment.header, ...segment.lines],
      ref: segment.ref,
    };
    if (bodySize([...current, whole]) <= budget) {
      current.push(whole);
      continue;
    }
    emit(current);
    current = [];
    if (pieceSize(whole) <= budget) {
      current.push(whole);
      continue;
    }

    // Too large for one chunk: split its lines under the repeated header. A
    // header that leaves little room (a very wide table) is not repeated but
    // treated like any other line.
    const headerSize = pieceSize({ lines: segment.header, ref: undefined });
    const repeatHeader =
      budget - headerSize - 1 >= Math.floor(limits.max * 0.25);
    const header = repeatHeader ? segment.header : [];
    const room = budget - (repeatHeader ? headerSize + 1 : 0);
    const columnRow = segment.header.find(
      (line) => line.includes('|') && !TABLE_SEPARATOR.test(line),
    );
    const lines = (
      repeatHeader ? segment.lines : [...segment.header, ...segment.lines]
    ).flatMap((line) => {
      if (line.length <= room) {
        return [line];
      }
      // A table row that cannot fit becomes `column: value` lines, so every
      // fragment still says which column it belongs to.
      return columnRow !== undefined && line.includes('|')
        ? asRecord(columnRow, line).flatMap((entry) =>
            entry.length <= room ? [entry] : splitLabeled(entry, room),
          )
        : hardSplit(line, room);
    });
    let window: string[] = [];
    let windowSize = 0;
    const flushWindow = (): void => {
      emit([{ lines: [...header, ...window], ref: segment.ref }]);
    };
    for (const line of lines) {
      const added = window.length === 0 ? line.length : line.length + 1;
      if (window.length > 0 && windowSize + added > room) {
        flushWindow();
        // Carry the last lines over as overlap, but always leave room for `line`.
        const carried: string[] = [];
        let carriedSize = 0;
        for (let i = window.length - 1; i >= 0; i--) {
          const candidate = window[i] as string;
          const next =
            carriedSize + candidate.length + (carried.length > 0 ? 1 : 0);
          if (next > limits.overlap || next + line.length + 1 > room) {
            break;
          }
          carried.unshift(candidate);
          carriedSize = next;
        }
        window = carried;
        windowSize = carriedSize;
      }
      windowSize += window.length === 0 ? line.length : line.length + 1;
      window.push(line);
    }
    if (window.length > 0) {
      flushWindow();
    }
  }
  emit(current);
  return chunks;
};

/**
 * Chunks a converted workbook. Blocks of one sheet share chunks when they are
 * small; large tables are split by rows with their column names repeated.
 */
export const chunkWorkbook = (
  workbook: WorkbookModel,
  options: ChunkOptions = {},
): Chunk[] => {
  const limits = resolveLimits(options);
  const chunks: Chunk[] = [];
  for (const sheet of workbook.sheets) {
    const segments: Segment[] = sheet.blocks.map((block) => {
      const { header, body } = blockLines(block);
      return {
        header: [`### ${block.ref}`, ...header],
        lines: body,
        ref: block.ref,
      };
    });
    const headingPath = [workbook.source, sheet.name];
    for (const packed of packSegments(
      segments,
      headingPath.join(' > '),
      limits,
    )) {
      chunks.push({
        metadata: {
          headingPath,
          refs: packed.refs,
          sheet: sheet.name,
          source: workbook.source,
        },
        text: packed.text,
      });
    }
  }
  return chunks;
};

/** An ATX heading; a closing `##` counts only after whitespace (`# C#` keeps its `#`). */
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
/** A fence is indented by at most three spaces; four make a code block. */
const FENCE = /^ {0,3}(```|~~~)/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Turns the lines of one blank-line-delimited block into a segment. */
const toSegment = (lines: readonly string[]): Segment => {
  const [first, second] = lines;
  if (
    first !== undefined &&
    second !== undefined &&
    first.includes('|') &&
    TABLE_SEPARATOR.test(second)
  ) {
    return { header: [first, second], lines: lines.slice(2), ref: undefined };
  }
  return { header: [], lines, ref: undefined };
};

/**
 * Chunks Markdown or plain text: one section per heading, tables kept whole
 * where possible, fenced code never split at blank lines.
 */
export const chunkMarkdown = (
  markdown: string,
  source: string,
  options: ChunkOptions = {},
): Chunk[] => {
  const limits = resolveLimits(options);
  const sections: { path: string[]; segments: Segment[] }[] = [];
  const stack: { level: number; title: string }[] = [];
  let section = { path: [source], segments: [] as Segment[] };
  sections.push(section);
  let block: string[] = [];
  let fenced = false;

  const closeBlock = (): void => {
    if (block.length > 0) {
      section.segments.push(toSegment(block));
      block = [];
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      block.push(line);
      continue;
    }
    const heading = fenced ? null : HEADING.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      closeBlock();
      const level = heading[1].length;
      while ((stack.at(-1)?.level ?? 0) >= level) {
        stack.pop();
      }
      stack.push({ level, title: heading[2] });
      section = {
        path: [source, ...stack.map((entry) => entry.title)],
        segments: [],
      };
      sections.push(section);
    } else if (!fenced && line.trim() === '') {
      closeBlock();
    } else {
      block.push(line);
    }
  }
  closeBlock();

  return sections.flatMap(({ path, segments }) =>
    packSegments(segments, path.join(' > '), limits).map((packed) => ({
      metadata: {
        headingPath: path,
        refs: packed.refs,
        sheet: undefined,
        source,
      },
      text: packed.text,
    })),
  );
};
