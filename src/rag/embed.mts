/** Subset of `fetch` that the embedder needs. */
export type EmbedFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Some embedding models are trained with a task prefix; omitting it hurts recall. */
export interface EmbeddingPrefixes {
  readonly document: string;
  readonly query: string;
}

export interface EmbedderOptions {
  /** Ollama base URL such as `http://127.0.0.1:11434`. */
  readonly baseUrl: string;
  readonly model: string;
  readonly fetch?: EmbedFetch;
  /** Texts per request (default 16). */
  readonly batchSize?: number;
  /** Retries after the first attempt for transient failures (default 3). */
  readonly retries?: number;
  /** Per-request timeout; the first call may load the model (default 120 s). */
  readonly timeoutMs?: number;
  /** Replaces the default prefixes for the model. */
  readonly prefixes?: EmbeddingPrefixes;
  /** Pause between retries, injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Embedder {
  readonly model: string;
  /** Vector length; known after the first successful call. */
  readonly dimension: number | undefined;
  /** Embeds passages. Vectors are L2-normalized, so cosine is a dot product. */
  embedDocuments(texts: readonly string[]): Promise<Float32Array[]>;
  /** Embeds a search query. */
  embedQuery(text: string): Promise<Float32Array>;
}

const NO_PREFIXES: EmbeddingPrefixes = { document: '', query: '' };

const KNOWN_PREFIXES: ReadonlyArray<readonly [RegExp, EmbeddingPrefixes]> = [
  [
    /^nomic-embed-text/i,
    { document: 'search_document: ', query: 'search_query: ' },
  ],
  [
    /^embeddinggemma/i,
    {
      document: 'title: none | text: ',
      query: 'task: search result | query: ',
    },
  ],
  [/(?:^|[-_/])e5(?:[-_:]|$)/i, { document: 'passage: ', query: 'query: ' }],
];

/** The prefixes a model was trained with; none for models without any. */
export const prefixesFor = (model: string): EmbeddingPrefixes =>
  KNOWN_PREFIXES.find(([pattern]) => pattern.test(model))?.[1] ?? NO_PREFIXES;

/** Scales a vector to unit length (a zero vector is returned unchanged). */
export const l2Normalize = (values: ArrayLike<number>): Float32Array => {
  const result = Float32Array.from(values);
  let sum = 0;
  for (const value of result) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < result.length; i++) {
      result[i] = (result[i] as number) / norm;
    }
  }
  return result;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const errorMessage = (error: unknown): string =>
  error instanceof Error
    ? String((error.cause as Error | undefined)?.message ?? error.message)
    : String(error);

const describeFailure = (
  status: number,
  body: string,
  model: string,
): string => {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === 'string') {
      detail = parsed.error;
    }
  } catch {
    // Not JSON: keep the raw body.
  }
  const hint =
    status === 404 ? ` (is the model pulled? try: ollama pull ${model})` : '';
  return `Ollama /api/embed failed with HTTP ${status}: ${detail}${hint}`;
};

const parseEmbeddings = (body: unknown, expected: number): number[][] => {
  const embeddings = (body as { embeddings?: unknown } | null)?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== expected) {
    throw new Error(
      `Malformed /api/embed response: expected ${expected} embeddings`,
    );
  }
  const width = (embeddings[0] as unknown[] | undefined)?.length ?? 0;
  for (const vector of embeddings) {
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      vector.length !== width ||
      !vector.every(
        (value) => typeof value === 'number' && Number.isFinite(value),
      )
    ) {
      throw new Error(
        'Malformed /api/embed response: vectors must be non-empty numeric arrays of one length',
      );
    }
  }
  return embeddings as number[][];
};

const requireText = (texts: readonly string[]): void => {
  texts.forEach((text, index) => {
    if (text.trim() === '') {
      throw new Error(`Cannot embed empty text (index ${index})`);
    }
  });
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** An embedder backed by Ollama's `/api/embed`. */
export const createOllamaEmbedder = (options: EmbedderOptions): Embedder => {
  const doFetch: EmbedFetch =
    options.fetch ?? ((input, init) => fetch(input, init));
  const batchSize = Number.isInteger(options.batchSize)
    ? Math.max(1, options.batchSize as number)
    : 16;
  // An unusable value (NaN, Infinity) must not mean "retry forever".
  const retries = Number.isInteger(options.retries)
    ? Math.max(0, options.retries as number)
    : 3;
  const timeoutMs = options.timeoutMs ?? 120_000;
  // A timer cannot take more than this; anything unusable is a mistake in the
  // configuration and fails here, not as a network error of every request.
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new RangeError(
      `timeoutMs must be an integer from 1 to 2147483647, got ${timeoutMs}`,
    );
  }
  const sleep = options.sleep ?? defaultSleep;
  const prefixes = options.prefixes ?? prefixesFor(options.model);
  let dimension: number | undefined;

  const requestBatch = async (
    batch: readonly string[],
  ): Promise<number[][]> => {
    for (let attempt = 0; ; attempt++) {
      const retry = async (): Promise<void> => {
        await sleep(Math.min(500 * 2 ** attempt, 8000));
      };
      let response: Awaited<ReturnType<EmbedFetch>>;
      let body: unknown;
      try {
        response = await doFetch(`${options.baseUrl}/api/embed`, {
          body: JSON.stringify({ input: batch, model: options.model }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
        });
        // A connection that drops (or times out) while the body streams in is
        // as transient as one that never connected.
        if (response.ok) {
          body = await response.json();
        }
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error('Malformed /api/embed response: not valid JSON', {
            cause: error,
          });
        }
        if (attempt < retries) {
          await retry();
          continue;
        }
        throw new Error(
          `Cannot reach Ollama at ${options.baseUrl}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      if (response.ok) {
        return parseEmbeddings(body, batch.length);
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
        await retry();
        continue;
      }
      throw new Error(
        describeFailure(
          response.status,
          await response.text().catch(() => ''),
          options.model,
        ),
      );
    }
  };

  const embed = async (texts: readonly string[]): Promise<Float32Array[]> => {
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      for (const raw of await requestBatch(batch)) {
        if (dimension !== undefined && raw.length !== dimension) {
          throw new Error(
            `Embedding dimension changed from ${dimension} to ${raw.length}; the model must not change mid-run`,
          );
        }
        dimension = raw.length;
        vectors.push(l2Normalize(raw));
      }
    }
    return vectors;
  };

  return {
    get dimension() {
      return dimension;
    },
    embedDocuments: async (texts) => {
      requireText(texts);
      return embed(texts.map((text) => prefixes.document + text));
    },
    embedQuery: async (text) => {
      requireText([text]);
      const [vector] = await embed([prefixes.query + text]);
      return vector as Float32Array;
    },
    model: options.model,
  };
};
