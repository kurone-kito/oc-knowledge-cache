import type { ModelInfo } from './types.mts';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/** Subset of the `fetch` API that this module needs. */
export type FetchLike = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

interface TagsEntry {
  readonly name?: unknown;
  readonly size?: unknown;
  readonly capabilities?: unknown;
  readonly details?: { readonly parameter_size?: unknown } | undefined;
}

interface ShowResponse {
  readonly capabilities?: unknown;
  readonly model_info?: Record<string, unknown> | undefined;
}

const DEFAULT_PORT = '11434';
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Turns an `OLLAMA_HOST`-style value (`127.0.0.1:11434`, `0.0.0.0`,
 * `http://box:11434/`, `:11434`) into a base URL a client can call.
 */
export const resolveOllamaBaseUrl = (host: string | undefined): string => {
  const raw = host?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_OLLAMA_URL;
  }
  const withHost = raw.startsWith(':') ? `127.0.0.1${raw}` : raw;
  const url = new URL(SCHEME.test(withHost) ? withHost : `http://${withHost}`);
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') {
    url.hostname = '127.0.0.1';
  }
  const authority = withHost.replace(SCHEME, '').split('/')[0] ?? '';
  if (url.protocol === 'http:' && !/:\d+$/.test(authority)) {
    url.port = DEFAULT_PORT;
  }
  return url.origin;
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asStrings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const SIZE_UNITS: Readonly<Record<string, number>> = {
  B: 1e9,
  K: 1e3,
  M: 1e6,
  T: 1e12,
};

/** Parses sizes such as `25.2B` and `494.03M` into a parameter count. */
export const parseParameterSize = (text: unknown): number | undefined => {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = /^\s*([\d.]+)\s*([KMBT])\s*$/i.exec(text);
  const unit = SIZE_UNITS[(match?.[2] ?? '').toUpperCase()];
  const value = Number(match?.[1]) * (unit ?? Number.NaN);
  return Number.isFinite(value) ? Math.round(value) : undefined;
};

/** Reads an architecture-scoped key such as `qwen35moe.context_length`. */
const archValue = (
  info: Record<string, unknown>,
  suffix: string,
): number | undefined => {
  const architecture = info['general.architecture'];
  const exact =
    typeof architecture === 'string'
      ? asNumber(info[`${architecture}.${suffix}`])
      : undefined;
  if (exact !== undefined) {
    return exact;
  }
  const found = Object.entries(info).find(([key]) =>
    key.endsWith(`.${suffix}`),
  );
  return asNumber(found?.[1]);
};

/**
 * Estimates the parameters used per token. A size hint in the tag (`a3b`) is
 * the most reliable; otherwise the expert ratio gives a lower bound.
 */
export const estimateActiveParameters = (
  name: string,
  parameterCount: number | undefined,
  expertCount: number | undefined,
  expertUsedCount: number | undefined,
): number | undefined => {
  const hint = /(?:^|[-:_])a(\d+(?:\.\d+)?)b(?:$|[-:_])/i.exec(name)?.[1];
  if (hint !== undefined) {
    return Math.round(Number(hint) * 1e9);
  }
  if (
    parameterCount !== undefined &&
    expertCount !== undefined &&
    expertUsedCount !== undefined &&
    expertCount > 1
  ) {
    return Math.round((parameterCount * expertUsedCount) / expertCount);
  }
  return undefined;
};

/** Combines an `/api/tags` entry with its `/api/show` response. */
export const toModelInfo = (
  tag: TagsEntry,
  show: ShowResponse | undefined,
): ModelInfo | undefined => {
  const name = typeof tag.name === 'string' ? tag.name : undefined;
  const sizeBytes = asNumber(tag.size);
  if (name === undefined || sizeBytes === undefined) {
    return undefined;
  }
  const info = show?.model_info ?? {};
  const parameterCount =
    asNumber(info['general.parameter_count']) ??
    parseParameterSize(tag.details?.parameter_size);
  return {
    activeParameterCount: estimateActiveParameters(
      name,
      parameterCount,
      archValue(info, 'expert_count'),
      archValue(info, 'expert_used_count'),
    ),
    capabilities: asStrings(show?.capabilities ?? tag.capabilities),
    contextLength: archValue(info, 'context_length'),
    name,
    parameterCount,
    sizeBytes,
  };
};

export interface ListModelsOptions {
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
}

const fetchShow = async (
  doFetch: FetchLike,
  baseUrl: string,
  name: unknown,
  signal: AbortSignal | undefined,
): Promise<ShowResponse | undefined> => {
  if (typeof name !== 'string') {
    return undefined;
  }
  try {
    const response = await doFetch(`${baseUrl}/api/show`, {
      body: JSON.stringify({ model: name }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    });
    return response.ok ? ((await response.json()) as ShowResponse) : undefined;
  } catch (error) {
    if (signal?.aborted === true) {
      // A timeout or cancellation is not a problem with this model: report it.
      throw error;
    }
    // `/api/tags` already supplied the basics; keep the model without details.
    return undefined;
  }
};

/** Lists the models installed in Ollama with their capabilities. */
export const listInstalledModels = async (
  options: ListModelsOptions = {},
): Promise<ModelInfo[]> => {
  const baseUrl = options.baseUrl ?? DEFAULT_OLLAMA_URL;
  const doFetch: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init));
  const signal = options.signal;

  const tagsResponse = await doFetch(
    `${baseUrl}/api/tags`,
    signal === undefined ? {} : { signal },
  ).catch((error: unknown) => {
    const cause = error instanceof Error ? (error.cause ?? error) : error;
    throw new Error(
      `Cannot reach Ollama at ${baseUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause: error },
    );
  });
  if (!tagsResponse.ok) {
    throw new Error(`Ollama /api/tags failed with HTTP ${tagsResponse.status}`);
  }
  const tags = (await tagsResponse.json()) as { models?: TagsEntry[] };

  const models = await Promise.all(
    (tags.models ?? []).map(async (tag) =>
      toModelInfo(tag, await fetchShow(doFetch, baseUrl, tag.name, signal)),
    ),
  );
  return models.filter((model): model is ModelInfo => model !== undefined);
};
