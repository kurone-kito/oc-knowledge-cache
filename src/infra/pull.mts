/** Subset of `fetch` that pulling a model needs: a streamed response body. */
export type PullFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
}>;

/** A pull that sends nothing for this long is given up (big pulls are fine). */
export const DEFAULT_PULL_IDLE_TIMEOUT_MS = 120_000;

export interface PullOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly fetch?: PullFetch;
  /** Called with a short progress line, at most once per percent. */
  readonly onProgress?: (line: string) => void;
  /**
   * How long the server may stay silent before the pull is abandoned. The
   * clock restarts with every chunk, so a slow but steady download is fine.
   */
  readonly idleTimeoutMs?: number;
}

interface PullLine {
  readonly status?: string;
  readonly error?: string;
  readonly total?: number;
  readonly completed?: number;
}

/**
 * Pulls a model through Ollama's streaming `/api/pull` and resolves when the
 * server reports success. A model that is already present finishes at once.
 * A server that goes silent makes the pull fail instead of hanging.
 */
export const pullModel = async (options: PullOptions): Promise<void> => {
  const doFetch: PullFetch =
    options.fetch ?? ((input, init) => fetch(input, init) as never);
  const idleMs = options.idleTimeoutMs ?? DEFAULT_PULL_IDLE_TIMEOUT_MS;

  const controller = new AbortController();
  const stalled = new Error(
    `ollama pull ${options.model} stalled: no data from the server for ${Math.round(idleMs / 1000)} s`,
  );
  // Rejects when the clock runs out; raced against every wait below so that
  // even a transport that ignores the abort signal cannot hold the pull.
  const abandoned = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(controller.signal.reason),
      { once: true },
    );
  });
  abandoned.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const watch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(stalled), idleMs);
  };

  try {
    watch();
    const response = await Promise.race([
      doFetch(`${options.baseUrl}/api/pull`, {
        body: JSON.stringify({ model: options.model, stream: true }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      }).catch((error: unknown) => {
        if (controller.signal.aborted) {
          throw stalled;
        }
        throw new Error(
          `Cannot reach Ollama at ${options.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }),
      abandoned,
    ]);
    if (!response.ok || response.body === null) {
      throw new Error(
        `ollama pull ${options.model} failed with HTTP ${response.status}: ${(await Promise.race([response.text().catch(() => ''), abandoned])).trim()}`,
      );
    }

    const decoder = new TextDecoder();
    let pending = '';
    let succeeded = false;
    let lastPercent = -1;

    const handle = (line: string): void => {
      // The success message ends the pull: whatever follows it is not read.
      if (succeeded || line.trim() === '') {
        return;
      }
      const message = JSON.parse(line) as PullLine;
      if (message.error !== undefined) {
        throw new Error(
          `ollama pull ${options.model} failed: ${message.error}`,
        );
      }
      if (message.status === 'success') {
        succeeded = true;
      }
      if (
        message.total !== undefined &&
        message.completed !== undefined &&
        message.total > 0
      ) {
        const percent = Math.floor((message.completed / message.total) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          options.onProgress?.(
            `${options.model}: ${message.status ?? 'downloading'} ${percent}%`,
          );
        }
      } else if (message.status !== undefined) {
        options.onProgress?.(`${options.model}: ${message.status}`);
      }
    };

    const chunks = response.body[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await Promise.race([chunks.next(), abandoned]);
        if (next.done) {
          break;
        }
        watch();
        pending += decoder.decode(next.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        lines.forEach(handle);
        if (succeeded) {
          // The pull is done; do not wait for a server that keeps the stream open.
          void chunks.return?.()?.catch(() => undefined);
          break;
        }
      }
    } catch (error) {
      // Release the connection without waiting for a server that is stuck.
      void chunks.return?.()?.catch(() => undefined);
      throw controller.signal.aborted ? stalled : error;
    }
    handle(pending + decoder.decode());
    if (!succeeded) {
      throw new Error(
        `ollama pull ${options.model} ended without a success message`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
};
