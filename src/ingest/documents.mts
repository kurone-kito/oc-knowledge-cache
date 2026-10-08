import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { convertWorkbookFile } from '../excel/convert.mts';
import {
  type Chunk,
  type ChunkOptions,
  chunkMarkdown,
  chunkWorkbook,
} from '../rag/chunk.mts';

export type LoadResult =
  /** Text was extracted and split into chunks (possibly none). */
  | { readonly status: 'ok'; readonly chunks: readonly Chunk[] }
  /** The file will never be readable as it is; do not retry until it changes. */
  | { readonly status: 'unsupported'; readonly message: string }
  /** A problem that may go away (file being written, share hiccup). */
  | { readonly status: 'failed'; readonly message: string };

export interface LoadOptions {
  readonly includeHidden?: boolean;
  readonly chunk?: ChunkOptions;
}

const WORKBOOK_EXTENSIONS = new Set(['.xlsx', '.xlsm']);
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

/** Whether the pipeline has a converter for the file name. */
export const isSupportedDocument = (relativePath: string): boolean => {
  const extension = posix.extname(relativePath).toLowerCase();
  return WORKBOOK_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension);
};

/**
 * Reads one file and turns it into chunks. `relativePath` (POSIX, relative to
 * the ingested source) names the document in citations.
 */
export const loadDocument = async (
  absolutePath: string,
  relativePath: string,
  options: LoadOptions = {},
): Promise<LoadResult> => {
  const extension = posix.extname(relativePath).toLowerCase();

  if (WORKBOOK_EXTENSIONS.has(extension)) {
    const result = await convertWorkbookFile(
      absolutePath,
      { includeHidden: options.includeHidden === true },
      relativePath,
    );
    if (result.ok) {
      return {
        chunks: chunkWorkbook(result.value.workbook, options.chunk),
        status: 'ok',
      };
    }
    return {
      message: result.error.message,
      status: result.error.code === 'unsupported' ? 'unsupported' : 'failed',
    };
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    let text: string;
    try {
      text = await readFile(absolutePath, 'utf8');
    } catch (error) {
      return {
        message: `${relativePath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        status: 'failed',
      };
    }
    if (text.includes('\u0000')) {
      return {
        message: `${relativePath} looks like a binary file`,
        status: 'unsupported',
      };
    }
    return {
      chunks: chunkMarkdown(text.replace(/^﻿/, ''), relativePath, options.chunk),
      status: 'ok',
    };
  }

  return {
    message: `No converter for ${extension === '' ? 'files without extension' : extension}`,
    status: 'unsupported',
  };
};
