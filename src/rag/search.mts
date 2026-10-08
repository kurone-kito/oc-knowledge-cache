import type { Embedder } from './embed.mts';
import type { SearchOptions, VectorStore } from './store.mts';

/** One search result in the shape that agents and people read. */
export interface KnowledgeHit {
  readonly rank: number;
  /** Cosine similarity, higher is closer. */
  readonly score: number;
  /** Document path relative to the ingested source. */
  readonly path: string;
  readonly sheet: string | undefined;
  /** Citations such as `Sheet1!A1:F20` for the blocks in the text. */
  readonly refs: readonly string[];
  /** Chunk text, starting with its `file > sheet` context line. */
  readonly text: string;
}

/** Embeds `query` and returns the closest chunks. */
export const searchKnowledge = async (
  store: VectorStore,
  embedder: Pick<Embedder, 'embedQuery'>,
  query: string,
  options: SearchOptions = {},
): Promise<KnowledgeHit[]> => {
  if (query.trim() === '') {
    throw new Error('The search query is empty');
  }
  const results = store.search(await embedder.embedQuery(query), options);
  return results.map((result, index) => ({
    path: result.path,
    rank: index + 1,
    refs: result.metadata.refs,
    score: result.score,
    sheet: result.metadata.sheet,
    text: result.text,
  }));
};

/**
 * Replaces control characters (ESC and the other C0/C1 codes) so that a file
 * name or cell value cannot drive the terminal with escape sequences.
 */
export const terminalSafe = (text: string): string =>
  Array.from(text, (char) => {
    const code = char.codePointAt(0) ?? 0;
    const control =
      (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f);
    return control ? '�' : char;
  }).join('');

const preview = (text: string, limit: number): string => {
  const flat = terminalSafe(text).replace(/\s*\n\s*/g, ' ⏎ ');
  // Count characters, not UTF-16 units: a cut must not split an emoji.
  const characters = Array.from(flat);
  return characters.length <= limit
    ? flat
    : `${characters.slice(0, limit - 1).join('')}…`;
};

/** Renders hits for the terminal. */
export const formatHits = (
  hits: readonly KnowledgeHit[],
  previewChars = 300,
): string => {
  if (hits.length === 0) {
    return 'No matching knowledge found.\n';
  }
  return `${hits
    .map((hit) =>
      [
        terminalSafe(
          `${hit.rank}. [${hit.score.toFixed(3)}] ${hit.path}${hit.refs.length > 0 ? `  (${hit.refs.join(', ')})` : ''}`,
        ),
        `   ${preview(hit.text, previewChars)}`,
      ].join('\n'),
    )
    .join('\n\n')}\n`;
};
