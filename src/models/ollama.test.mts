import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  estimateActiveParameters,
  type FetchLike,
  listInstalledModels,
  parseParameterSize,
  resolveOllamaBaseUrl,
  toModelInfo,
} from './ollama.mts';

/** Trimmed copies of real `/api/show` responses. */
const SHOW: Record<string, unknown> = {
  'gpt-oss:latest': {
    capabilities: ['completion', 'tools', 'thinking'],
    model_info: {
      'general.architecture': 'gptoss',
      'general.parameter_count': 20914757184,
      'gptoss.context_length': 131072,
      'gptoss.expert_count': 32,
      'gptoss.expert_used_count': 4,
    },
  },
  'nomic-embed-text-v2-moe:latest': {
    capabilities: ['embedding'],
    model_info: {
      'general.architecture': 'nomic-bert-moe',
      'general.parameter_count': 475288320,
      'nomic-bert-moe.context_length': 512,
    },
  },
  'qwen3.6:35b-a3b-coding': {
    capabilities: ['completion', 'vision', 'tools', 'thinking'],
    model_info: {
      'general.architecture': 'qwen35moe',
      'general.parameter_count': 35505251456,
      'qwen35moe.context_length': 262144,
      'qwen35moe.expert_count': 256,
      'qwen35moe.expert_used_count': 8,
    },
  },
};

const TAGS = {
  models: [
    {
      details: { parameter_size: '20.9B' },
      name: 'gpt-oss:latest',
      size: 13793441244,
    },
    {
      details: { parameter_size: '475.29M' },
      name: 'nomic-embed-text-v2-moe:latest',
      size: 957680763,
    },
    {
      details: { parameter_size: '35.5B' },
      name: 'qwen3.6:35b-a3b-coding',
      size: 22621314381,
    },
  ],
};

const reply = (body: unknown, status = 200) => ({
  json: async () => body,
  ok: status >= 200 && status < 300,
  status,
});

const fakeFetch =
  (calls: string[] = [], failShowFor?: string): FetchLike =>
  async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${input}`);
    if (input.endsWith('/api/tags')) {
      return reply(TAGS);
    }
    const { model } = JSON.parse(init?.body ?? '{}') as { model: string };
    return model === failShowFor ? reply({}, 500) : reply(SHOW[model]);
  };

describe('resolveOllamaBaseUrl', () => {
  const cases: ReadonlyArray<[string | undefined, string]> = [
    [undefined, 'http://127.0.0.1:11434'],
    ['', 'http://127.0.0.1:11434'],
    ['127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['0.0.0.0', 'http://127.0.0.1:11434'],
    ['0.0.0.0:8080', 'http://127.0.0.1:8080'],
    [':11500', 'http://127.0.0.1:11500'],
    ['gpu-box', 'http://gpu-box:11434'],
    ['http://gpu-box:11434/', 'http://gpu-box:11434'],
    ['https://ollama.example.com', 'https://ollama.example.com'],
  ];
  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)} to ${expected}`, () => {
      assert.equal(resolveOllamaBaseUrl(input), expected);
    });
  }
});

describe('parseParameterSize', () => {
  it('understands B, M and K suffixes', () => {
    assert.equal(parseParameterSize('25.2B'), 25.2e9);
    assert.equal(parseParameterSize('475.29M'), 475.29e6);
    assert.equal(parseParameterSize('7b'), 7e9);
  });

  it('returns undefined for anything else', () => {
    assert.equal(parseParameterSize(undefined), undefined);
    assert.equal(parseParameterSize('big'), undefined);
    assert.equal(parseParameterSize(7), undefined);
  });
});

describe('estimateActiveParameters', () => {
  it('prefers the size hint in the tag', () => {
    assert.equal(
      estimateActiveParameters('gemma4:26b-a4b-it-q4_K_M', 25.8e9, 128, 8),
      4e9,
    );
    assert.equal(
      estimateActiveParameters('qwen3.6:35b-a3b-coding', 35.5e9, 256, 8),
      3e9,
    );
  });

  it('falls back to the expert ratio', () => {
    assert.equal(estimateActiveParameters('gpt-oss:latest', 32e9, 32, 4), 4e9);
  });

  it('is undefined for dense models', () => {
    assert.equal(
      estimateActiveParameters('gemma4:e4b', 7.5e9, undefined, undefined),
      undefined,
    );
    assert.equal(estimateActiveParameters('x', 1e9, 1, 1), undefined);
  });
});

describe('toModelInfo', () => {
  it('merges tags and show data for a MoE model', () => {
    const tag = TAGS.models[2];
    assert.ok(tag);
    assert.deepEqual(
      toModelInfo(tag, SHOW['qwen3.6:35b-a3b-coding'] as never),
      {
        activeParameterCount: 3e9,
        capabilities: ['completion', 'vision', 'tools', 'thinking'],
        contextLength: 262144,
        name: 'qwen3.6:35b-a3b-coding',
        parameterCount: 35505251456,
        sizeBytes: 22621314381,
      },
    );
  });

  it('keeps the basics when /api/show is unavailable', () => {
    const tag = {
      capabilities: ['completion'],
      details: { parameter_size: '7.5B' },
      name: 'm',
      size: 100,
    };
    assert.deepEqual(toModelInfo(tag, undefined), {
      activeParameterCount: undefined,
      capabilities: ['completion'],
      contextLength: undefined,
      name: 'm',
      parameterCount: 7.5e9,
      sizeBytes: 100,
    });
  });

  it('drops entries without a name or size', () => {
    assert.equal(toModelInfo({ size: 1 }, undefined), undefined);
    assert.equal(toModelInfo({ name: 'x' }, undefined), undefined);
  });
});

describe('listInstalledModels', () => {
  it('reads /api/tags and /api/show for every model', async () => {
    const calls: string[] = [];
    const models = await listInstalledModels({
      baseUrl: 'http://ollama.test',
      fetch: fakeFetch(calls),
    });
    assert.deepEqual(
      models.map((m) => m.name),
      [
        'gpt-oss:latest',
        'nomic-embed-text-v2-moe:latest',
        'qwen3.6:35b-a3b-coding',
      ],
    );
    assert.deepEqual(models[1]?.capabilities, ['embedding']);
    assert.equal(models[0]?.contextLength, 131072);
    assert.equal(calls[0], 'GET http://ollama.test/api/tags');
    assert.equal(calls.filter((c) => c.startsWith('POST')).length, 3);
  });

  it('keeps a model whose /api/show call fails', async () => {
    const models = await listInstalledModels({
      fetch: fakeFetch([], 'gpt-oss:latest'),
    });
    const gptOss = models.find((m) => m.name === 'gpt-oss:latest');
    assert.equal(gptOss?.contextLength, undefined);
    assert.equal(gptOss?.parameterCount, 20.9e9);
  });

  it('reports a timeout during /api/show instead of hiding the model details', async () => {
    const controller = new AbortController();
    const base = fakeFetch();
    await assert.rejects(
      listInstalledModels({
        fetch: async (input, init) => {
          if (input.endsWith('/api/show')) {
            controller.abort(new Error('timed out'));
            throw new Error('The operation was aborted');
          }
          return base(input, init);
        },
        signal: controller.signal,
      }),
      /aborted/,
    );
  });

  it('explains when the server cannot be reached', async () => {
    await assert.rejects(
      listInstalledModels({
        baseUrl: 'http://ollama.test',
        fetch: async () => {
          throw new TypeError('fetch failed', {
            cause: new Error('connect ECONNREFUSED'),
          });
        },
      }),
      /Cannot reach Ollama at http:\/\/ollama\.test: connect ECONNREFUSED/,
    );
  });

  it('rejects when /api/tags fails', async () => {
    await assert.rejects(
      listInstalledModels({ fetch: async () => reply({}, 503) }),
      /HTTP 503/,
    );
  });
});
