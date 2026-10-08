import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { exceljsReader } from './exceljs-reader.mts';
import { workbookToMarkdown } from './markdown.mts';
import { type BuildOptions, buildWorkbookModel } from './model.mts';
import type { WorkbookModel, WorkbookReader } from './types.mts';

export interface Conversion {
  readonly workbook: WorkbookModel;
  readonly markdown: string;
}

export interface ConvertFailure {
  /**
   * - `unsupported`: an OLE2 file, i.e. a legacy `.xls` or a password-protected
   *   workbook, which this reader cannot open.
   * - `corrupt`: not a readable `.xlsx`.
   * - `io`: the file could not be read from disk.
   */
  readonly code: 'unsupported' | 'corrupt' | 'io';
  readonly message: string;
}

export type ConvertResult =
  | { readonly ok: true; readonly value: Conversion }
  | { readonly ok: false; readonly error: ConvertFailure };

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_MAGIC = [0x50, 0x4b];

const startsWith = (data: Uint8Array, magic: readonly number[]): boolean =>
  data.length >= magic.length &&
  magic.every((byte, index) => data[index] === byte);

/** Converts the bytes of a workbook into the JSON model and Markdown. */
export const convertWorkbookBytes = async (
  data: Uint8Array,
  source: string,
  options: BuildOptions = {},
  reader: WorkbookReader = exceljsReader,
): Promise<ConvertResult> => {
  if (startsWith(data, OLE2_MAGIC)) {
    return {
      error: {
        code: 'unsupported',
        message: `${source} is a legacy .xls or a password-protected workbook`,
      },
      ok: false,
    };
  }
  if (!startsWith(data, ZIP_MAGIC)) {
    return {
      error: { code: 'corrupt', message: `${source} is not an .xlsx file` },
      ok: false,
    };
  }
  try {
    const workbook = buildWorkbookModel(
      source,
      await reader.read(data),
      options,
    );
    return {
      ok: true,
      value: { markdown: workbookToMarkdown(workbook), workbook },
    };
  } catch (error) {
    return {
      error: {
        code: 'corrupt',
        message: `${source} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      },
      ok: false,
    };
  }
};

/** Reads and converts a workbook file. Failures are returned, not thrown. */
export const convertWorkbookFile = async (
  file: string,
  options: BuildOptions = {},
  source: string = basename(file),
): Promise<ConvertResult> => {
  let data: Uint8Array;
  try {
    data = await readFile(file);
  } catch (error) {
    return {
      error: {
        code: 'io',
        message: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      },
      ok: false,
    };
  }
  return convertWorkbookBytes(data, source, options);
};
