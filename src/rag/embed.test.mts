import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createOllamaEmbedder,
  EmbeddingUnavailableError,
  type EmbedFetch,
  l2Normalize,
  prefixesFor,
} from './embed.mts';

interface Call {
  readonly url: string;
  readonly body: { model: string; input: string[] };
  readonly signal: AbortSignal;
}

type Responder = (call: Call, attempt: number) => unknown;

const reply = (status: number, body: unknown) => ({
  json: async () => body,
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** A fake Ollama: `respond` returns a body (200) or a ready-made reply. */
const fakeOllama = (
  respond: Responder,
): { fetch: EmbedFetch; calls: Call[] } => {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call: Call = {
        body: JSON.parse(init.body) as Call['body'],
        signal: init.signal,
        url,
      };
      calls.push(call);
      const result = respond(call, calls.length - 1);
      if (result instanceof Error) {
        throw result;
      }
      return (result as { ok?: boolean }).ok === undefined
        ? reply(200, result)
        : (result as ReturnType<typeof reply>);
    },
  };
};

/** Vector for a text: its length in dimension 0, a constant in dimension 1. */
const vectorsFor = (call: Call): { embeddings: number[][] } => ({
  embeddings: call.body.input.map((text) => [text.length, 1]),
});

const embedderFor = (
  respond: Responder,
  extra: { batchSize?: number; retries?: number; model?: string } = {},
) => {
  const fake = fakeOllama(respond);
  const sleeps: number[] = [];
  const embedder = createOllamaEmbedder({
    baseUrl: 'http://ollama.test',
    fetch: fake.fetch,
    model: extra.model ?? 'plain-model',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(extra.batchSize === undefined ? {} : { batchSize: extra.batchSize }),
    ...(extra.retries === undefined ? {} : { retries: extra.retries }),
  });
  return { calls: fake.calls, embedder, sleeps };
};

describe('createOllamaEmbedder options', () => {
  it('refuses a timeout that no timer could use, at creation', () => {
    for (const timeoutMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      0,
      1.5,
      2 ** 31,
    ]) {
      assert.throws(
        () =>
          createOllamaEmbedder({
            baseUrl: 'http://x',
            model: 'm',
            timeoutMs,
          }),
        RangeError,
        String(timeoutMs),
      );
    }
    assert.doesNotThrow(() =>
      createOllamaEmbedder({
        baseUrl: 'http://x',
        model: 'm',
        timeoutMs: 1000,
      }),
    );
  });
});

describe('l2Normalize', () => {
  it('scales a vector to unit length', () => {
    const v = l2Normalize([3, 4]);
    assert.ok(Math.abs((v[0] ?? 0) - 0.6) < 1e-6);
    assert.ok(Math.abs((v[1] ?? 0) - 0.8) < 1e-6);
  });

  it('leaves a zero vector alone', () => {
    assert.deepEqual([...l2Normalize([0, 0])], [0, 0]);
  });
});

describe('prefixesFor', () => {
  it('knows the models that need task prefixes', () => {
    assert.deepEqual(prefixesFor('nomic-embed-text-v2-moe:latest'), {
      document: 'search_document: ',
      query: 'search_query: ',
    });
    assert.equal(
      prefixesFor('embeddinggemma').query,
      'task: search result | query: ',
    );
    assert.equal(prefixesFor('multilingual-e5-large').document, 'passage: ');
  });

  it('uses no prefix for other models', () => {
    assert.deepEqual(prefixesFor('bge-m3'), { document: '', query: '' });
  });
});

describe('createOllamaEmbedder', () => {
  it('sends batches in order and returns normalized vectors', async () => {
    const { calls, embedder } = embedderFor(vectorsFor, { batchSize: 2 });
    const vectors = await embedder.embedDocuments([
      'a',
      'bb',
      'ccc',
      'dddd',
      'eeeee',
    ]);

    assert.deepEqual(
      calls.map((c) => c.body.input),
      [['a', 'bb'], ['ccc', 'dddd'], ['eeeee']],
    );
    assert.equal(calls[0]?.url, 'http://ollama.test/api/embed');
    assert.equal(calls[0]?.body.model, 'plain-model');
    assert.equal(vectors.length, 5);
    for (const [i, v] of vectors.entries()) {
      assert.ok(
        Math.abs(Math.hypot(...v) - 1) < 1e-6,
        `vector ${i} is unit length`,
      );
    }
    // Order is preserved: the first component grows with the text length.
    const firsts = vectors.map((v) => v[0] as number);
    assert.deepEqual(
      firsts,
      [...firsts].sort((a, b) => a - b),
    );
    assert.equal(embedder.dimension, 2);
  });

  it('applies the document and query prefixes of the model', async () => {
    const { calls, embedder } = embedderFor(vectorsFor, {
      model: 'nomic-embed-text-v2-moe',
    });
    await embedder.embedDocuments(['設計書']);
    await embedder.embedQuery('画面一覧');
    assert.deepEqual(calls[0]?.body.input, ['search_document: 設計書']);
    assert.deepEqual(calls[1]?.body.input, ['search_query: 画面一覧']);
  });

  it('does nothing for no input', async () => {
    const { calls, embedder } = embedderFor(vectorsFor);
    assert.deepEqual(await embedder.embedDocuments([]), []);
    assert.equal(calls.length, 0);
  });

  it('refuses blank text before calling the server', async () => {
    const { calls, embedder } = embedderFor(vectorsFor, {
      model: 'nomic-embed-text',
    });
    await assert.rejects(
      embedder.embedDocuments(['ok', '  ']),
      /empty text \(index 1\)/,
    );
    await assert.rejects(embedder.embedQuery(''), /empty text/);
    assert.equal(calls.length, 0);
  });

  it('retries transient failures with growing pauses, then succeeds', async () => {
    const { calls, embedder, sleeps } = embedderFor((call, attempt) =>
      attempt < 2 ? reply(503, { error: 'busy' }) : vectorsFor(call),
    );
    const vectors = await embedder.embedDocuments(['x']);
    assert.equal(vectors.length, 1);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [500, 1000]);
  });

  it('retries network errors and reports the cause when they persist', async () => {
    const failure = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:11434'),
    });
    const { calls, embedder } = embedderFor(() => failure, { retries: 2 });
    await assert.rejects(
      embedder.embedDocuments(['x']),
      (error: unknown) =>
        error instanceof EmbeddingUnavailableError &&
        error.message.includes(
          'Cannot reach Ollama at http://ollama.test: connect ECONNREFUSED',
        ),
    );
    assert.equal(calls.length, 3);
  });

  it('gives up after the configured number of retries', async () => {
    const { calls, embedder } = embedderFor(
      () => reply(500, { error: 'boom' }),
      {
        retries: 1,
      },
    );
    await assert.rejects(
      embedder.embedDocuments(['x']),
      (error: unknown) =>
        !(error instanceof EmbeddingUnavailableError) &&
        /HTTP 500: boom/.test((error as Error).message),
    );
    assert.equal(calls.length, 2);
  });

  it('treats a service that stays busy or gone as unusable, not as a bad text', async () => {
    for (const status of [429, 502, 503, 504]) {
      const { calls, embedder } = embedderFor(
        () => reply(status, { error: 'busy' }),
        { retries: 1 },
      );
      await assert.rejects(
        embedder.embedDocuments(['x']),
        (error: unknown) =>
          error instanceof EmbeddingUnavailableError &&
          error.message.includes(`HTTP ${status}`),
        String(status),
      );
      assert.equal(calls.length, 2, `retried once for ${status}`);
    }
  });

  it('retries a slow or early request but leaves it an ordinary failure of that text', async () => {
    for (const status of [408, 425]) {
      const { calls, embedder } = embedderFor(
        () => reply(status, { error: 'try again' }),
        { retries: 1 },
      );
      await assert.rejects(
        embedder.embedDocuments(['x']),
        (error: unknown) =>
          !(error instanceof EmbeddingUnavailableError) &&
          (error as Error).message.includes(`HTTP ${status}`),
        String(status),
      );
      assert.equal(calls.length, 2, `retried once for ${status}`);
    }
  });

  it('does not retry client errors', async () => {
    const { calls, embedder } = embedderFor(() =>
      reply(400, { error: 'bad input' }),
    );
    await assert.rejects(embedder.embedDocuments(['x']), /HTTP 400: bad input/);
    assert.equal(calls.length, 1);
  });

  it('tells the user to pull a missing model', async () => {
    const { embedder } = embedderFor(
      () => reply(404, { error: "model 'bge-m3' not found" }),
      { model: 'bge-m3' },
    );
    await assert.rejects(
      embedder.embedDocuments(['x']),
      (error: unknown) =>
        error instanceof EmbeddingUnavailableError &&
        /ollama pull bge-m3/.test(error.message),
    );
  });

  it('passes a timeout signal with every request', async () => {
    const { calls, embedder } = embedderFor(vectorsFor);
    await embedder.embedDocuments(['x']);
    assert.ok(calls[0]?.signal instanceof AbortSignal);
  });

  it('retries when the connection drops while the body is read', async () => {
    const fake = fakeOllama(vectorsFor);
    let dropped = false;
    const embedder = createOllamaEmbedder({
      baseUrl: 'http://ollama.test',
      fetch: async (url, init) => {
        const response = await fake.fetch(url, init);
        if (dropped) {
          return response;
        }
        dropped = true;
        return {
          ...response,
          json: async () => {
            throw new TypeError('terminated');
          },
        };
      },
      model: 'plain-model',
      sleep: async () => {},
    });
    assert.equal((await embedder.embedDocuments(['x'])).length, 1);
    assert.equal(fake.calls.length, 2, 'the request was repeated');
  });

  it('falls back to the default batch size when it is not a usable integer', async () => {
    for (const batchSize of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      const fake = fakeOllama(vectorsFor);
      const embedder = createOllamaEmbedder({
        baseUrl: 'http://ollama.test',
        batchSize,
        fetch: fake.fetch,
        model: 'plain-model',
      });
      assert.equal((await embedder.embedDocuments(['a', 'b', 'c'])).length, 3);
      assert.equal(fake.calls.length, 1, `one batch for ${batchSize}`);
    }
  });

  it('does not retry forever when the retry count is unusable', async () => {
    for (const retries of [Number.POSITIVE_INFINITY, Number.NaN, 1.5]) {
      const fake = fakeOllama(() => reply(503, { error: 'busy' }));
      const embedder = createOllamaEmbedder({
        baseUrl: 'http://ollama.test',
        fetch: fake.fetch,
        model: 'plain-model',
        retries,
        sleep: async () => {},
      });
      await assert.rejects(
        embedder.embedDocuments(['x']),
        /HTTP 503/,
        String(retries),
      );
      assert.equal(
        fake.calls.length,
        4,
        `the default of 3 retries for ${retries}`,
      );
    }
  });

  it('does not retry a body that is not JSON', async () => {
    let calls = 0;
    const embedder = createOllamaEmbedder({
      baseUrl: 'http://ollama.test',
      fetch: async () => {
        calls++;
        return {
          json: async () => JSON.parse('<html>'),
          ok: true,
          status: 200,
          text: async () => '',
        };
      },
      model: 'plain-model',
      sleep: async () => {},
    });
    await assert.rejects(embedder.embedDocuments(['x']), /not valid JSON/);
    assert.equal(calls, 1);
  });

  it('rejects malformed responses', async () => {
    const cases: ReadonlyArray<[string, unknown]> = [
      ['no embeddings', {}],
      ['wrong count', { embeddings: [[1, 2]] }],
      ['empty vector', { embeddings: [[], []] }],
      ['non-numeric', { embeddings: [['a'], ['b']] }],
      ['ragged', { embeddings: [[1, 2], [1]] }],
      [
        'not finite',
        {
          embeddings: [
            [1, null],
            [1, 2],
          ],
        },
      ],
    ];
    for (const [name, body] of cases) {
      const { embedder } = embedderFor(() => reply(200, body));
      await assert.rejects(
        embedder.embedDocuments(['a', 'b']),
        /Malformed \/api\/embed response/,
        name,
      );
    }
  });

  it('refuses a dimension change between batches', async () => {
    const { embedder } = embedderFor((call) => ({
      embeddings: call.body.input.map(() =>
        call.body.input[0] === 'first' ? [1, 0] : [1, 0, 0],
      ),
    }));
    await embedder.embedDocuments(['first']);
    await assert.rejects(
      embedder.embedDocuments(['second']),
      /dimension changed from 2 to 3/,
    );
  });
});
