import type { BlockModel, WorkbookModel } from './types.mts';

/**
 * A backslash right before a pipe would swallow the pipe's escape (`a\|b`
 * reads as `a\` + a column break), so it is doubled first.
 */
const cellText = (text: string): string =>
  text
    .replace(/\\(?=\|)/g, '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, '<br>');

/**
 * Keeps text that looks like Markdown structure (headings, quotes, fences,
 * rules, list items) from changing the document. A backslash only escapes
 * punctuation, so an ordered-list marker is escaped at its dot.
 */
// A single replacement keeps the digits: `1. step` becomes `1\. step`.
const plainLine = (line: string): string => {
  if (/^\s*\d+[.)]\s/.test(line)) {
    return line.replace(/^(\s*\d+)([.)])/, '$1\\$2');
  }
  return /^\s*(?:#{1,6}(?:\s|$)|>|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$|[-+*]\s)/.test(
    line,
  )
    ? `\\${line}`
    : line;
};

const renderTable = (rows: readonly (readonly string[])[]): string => {
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cellText(row[i] ?? '')).join(' | ')} |`;
  const [header = [], ...body] = rows;
  return [
    line(header),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(line),
  ].join('\n');
};

/** Renders one block as Markdown, without its heading. */
export const renderBlock = (block: BlockModel): string => {
  switch (block.kind) {
    case 'table':
      return renderTable(block.rows);
    case 'list':
      return block.rows
        .map((row) => `- ${plainLine((row[0] ?? '').replace(/\r?\n/g, ' '))}`)
        .join('\n');
    case 'paragraph':
      return (block.rows[0]?.[0] ?? '')
        .split(/\r?\n/)
        .map(plainLine)
        .join('\n');
  }
};

/**
 * Renders a workbook: a title, one section per sheet and one subsection per
 * block, headed by the citation (`Sheet1!A1:F20`).
 */
export const workbookToMarkdown = (workbook: WorkbookModel): string => {
  const parts: string[] = [`# ${workbook.source}`];
  for (const sheet of workbook.sheets) {
    if (sheet.blocks.length === 0) {
      continue;
    }
    parts.push(`## ${sheet.name}`);
    for (const block of sheet.blocks) {
      parts.push(`### ${block.ref}`, renderBlock(block));
    }
  }
  return `${parts.join('\n\n')}\n`;
};
