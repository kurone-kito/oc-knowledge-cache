import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { machine, model, REAL_INVENTORY } from '../models/fixtures.mts';
import { absolute } from '../openclaw/profiles.mts';
import {
  computePlan,
  describePlan,
  isInstalled,
  type MachineState,
  type RenderedProfiles,
} from './plan.mts';

const rendered = (extra: Partial<RenderedProfiles> = {}): RenderedProfiles => ({
  agentModel: 'qwen3.6:35b-a3b-coding',
  ollamaUrl: 'http://127.0.0.1:11434',
  problems: [],
  projectRepo: undefined,
  ...extra,
});

const missing = rendered({
  agentModel: undefined,
  ollamaUrl: undefined,
  problems: ['the OpenClaw profiles have not been generated'],
});

const converged = (extra: Partial<MachineState> = {}): MachineState => ({
  hardware: machine(63.8, 8),
  installedModels: REAL_INVENTORY,
  ollamaReachable: true,
  openclawVersion: 'OpenClaw 2026.9.9',
  profiles: rendered(),
  storeModel: undefined,
  ...extra,
});

const kinds = (state: MachineState, options = {}): string[] =>
  computePlan(state, options).actions.map((a) =>
    a.kind === 'manual' ? `manual:${a.topic}` : a.kind,
  );

describe('computePlan', () => {
  it('has nothing to do on a converged machine', () => {
    const plan = computePlan(converged());
    assert.deepEqual(plan.actions, []);
    assert.equal(plan.agentModel, 'qwen3.6:35b-a3b-coding');
    assert.equal(plan.embeddingModel, 'nomic-embed-text-v2-moe:latest');
    assert.deepEqual(describePlan(plan), []);
  });

  it('asks a person to start Ollama and does not pretend to know the models', () => {
    const plan = computePlan(
      converged({ installedModels: [], ollamaReachable: false }),
    );
    assert.deepEqual(
      plan.actions.map((a) => a.kind),
      ['manual'],
    );
    assert.equal(plan.agentModel, undefined);
    assert.match(
      describePlan(plan)[0] ?? '',
      /MANUAL: Install and start Ollama/,
    );
  });

  it('pulls what an empty Ollama needs, then generates the profiles for it', () => {
    const plan = computePlan(
      converged({ installedModels: [], profiles: missing }),
    );
    assert.deepEqual(
      plan.actions.map((a) =>
        a.kind === 'pull-model' ? `pull:${a.role}:${a.model}` : a.kind,
      ),
      [
        'pull:agent:gemma4:26b-a4b-it-q4_K_M',
        'pull:embedding:bge-m3',
        'render-profiles',
      ],
    );
    const render = plan.actions.at(-1);
    assert.equal(
      render?.kind === 'render-profiles' && render.agentModel,
      'gemma4:26b-a4b-it-q4_K_M',
    );
  });

  it('finds the missing OpenClaw and leaves its installation to a person', () => {
    const plan = computePlan(converged({ openclawVersion: undefined }));
    assert.deepEqual(kinds(converged({ openclawVersion: undefined })), [
      'manual:install-openclaw',
    ]);
    assert.match(describePlan(plan)[0] ?? '', /does not install it for you/);
  });

  it('regenerates the profiles when they were made for another model', () => {
    const plan = computePlan(
      converged({ profiles: rendered({ agentModel: 'gpt-oss:latest' }) }),
    );
    assert.deepEqual(
      plan.actions.map((a) => a.kind),
      ['render-profiles'],
    );
    assert.match(
      describePlan(plan)[0] ?? '',
      /use gpt-oss:latest, not qwen3\.6/,
    );
  });

  it('generates the profiles when they do not exist', () => {
    assert.deepEqual(kinds(converged({ profiles: missing })), [
      'render-profiles',
    ]);
    assert.match(
      describePlan(computePlan(converged({ profiles: missing })))[0] ?? '',
      /have not been generated/,
    );
  });

  it('regenerates profiles that are broken or lost their isolation, whatever model they name', () => {
    const state = converged({
      profiles: rendered({
        problems: ['the web profile has no openclaw.json'],
      }),
    });
    const plan = computePlan(state);
    assert.deepEqual(
      plan.actions.map((a) => a.kind),
      ['render-profiles'],
    );
    assert.match(describePlan(plan)[0] ?? '', /web profile has no openclaw/);
  });

  it('regenerates the profiles when the Ollama server or the project repository changed', () => {
    const url = computePlan(converged(), {
      ollamaUrl: 'http://gpu-box:11434',
    });
    assert.match(
      describePlan(url)[0] ?? '',
      /Ollama server http:\/\/127\.0\.0\.1:11434, not http:\/\/gpu-box:11434/,
    );
    const repo = computePlan(converged(), { projectRepo: '/work/app' });
    assert.match(describePlan(repo)[0] ?? '', /no project repository, not/);
    const cleared = computePlan(
      converged({ profiles: rendered({ projectRepo: '/work/app' }) }),
      { projectRepo: undefined },
    );
    assert.match(
      describePlan(cleared)[0] ?? '',
      /work on \/work\/app, not no project repository/,
    );
  });

  it('leaves profiles alone when the server and the project repository are the same', () => {
    const state = converged({
      profiles: rendered({ projectRepo: absolute('/work/app') }),
    });
    const plan = computePlan(state, {
      ollamaUrl: 'http://127.0.0.1:11434/',
      projectRepo: '/work/app',
    });
    assert.deepEqual(plan.actions, []);
  });

  it('does not generate profiles while Ollama is unreachable, even for an explicit model', () => {
    const plan = computePlan(
      converged({
        installedModels: [],
        ollamaReachable: false,
        profiles: missing,
      }),
      { agentModel: 'gpt-oss:latest' },
    );
    assert.deepEqual(
      plan.actions.map((a) => a.kind),
      ['manual'],
    );
  });

  it('keeps the embedding model of an existing cache', () => {
    const state = converged({
      installedModels: [
        ...REAL_INVENTORY,
        model({
          capabilities: ['embedding'],
          contextLength: 8192,
          name: 'bge-m3',
          sizeGiB: 1,
        }),
      ],
      storeModel: 'nomic-embed-text-v2-moe:latest',
    });
    const plan = computePlan(state);
    assert.equal(plan.embeddingModel, 'nomic-embed-text-v2-moe:latest');
    assert.deepEqual(plan.actions, []);
  });

  it('does not let an explicit embedding model replace the one of an existing cache', () => {
    const plan = computePlan(
      converged({ storeModel: 'nomic-embed-text-v2-moe:latest' }),
      { embeddingModel: 'bge-m3' },
    );
    assert.equal(plan.embeddingModel, 'nomic-embed-text-v2-moe:latest');
    assert.deepEqual(plan.actions, [], 'nothing is pulled for the other model');
    assert.match(
      describePlan(plan).join(' | '),
      /UNMET: The cache was built with nomic-embed-text-v2-moe:latest, so it cannot use bge-m3/,
    );
    // The same model by another spelling is no mismatch.
    const same = computePlan(
      converged({ storeModel: 'nomic-embed-text-v2-moe:latest' }),
      { embeddingModel: 'nomic-embed-text-v2-moe' },
    );
    assert.deepEqual(same.unmet, []);
    assert.equal(
      same.embeddingModel,
      'nomic-embed-text-v2-moe:latest',
      "the cache's own spelling is the one that is passed on",
    );
  });

  it('pulls the model of an existing cache if it was removed', () => {
    const plan = computePlan(converged({ storeModel: 'old-embedder:latest' }));
    assert.deepEqual(
      plan.actions.map((a) => a.kind === 'pull-model' && a.model),
      ['old-embedder:latest'],
    );
  });

  it('honors explicitly chosen models', () => {
    const plan = computePlan(converged(), {
      agentModel: 'gpt-oss:latest',
      embeddingModel: 'bge-m3',
    });
    assert.deepEqual(
      plan.actions.map((a) =>
        a.kind === 'pull-model' ? `pull:${a.model}` : a.kind,
      ),
      ['pull:bge-m3', 'render-profiles'],
    );
  });

  it('says so when no model fits the machine', () => {
    const plan = computePlan(
      converged({
        hardware: machine(2, 0),
        installedModels: [],
        profiles: missing,
      }),
    );
    assert.equal(plan.agentModel, undefined);
    assert.ok(plan.unmet.some((note) => /No agent model fits/.test(note)));
    assert.match(describePlan(plan).join(' | '), /UNMET: No agent model fits/);
    assert.ok(!plan.actions.some((a) => a.kind === 'render-profiles'));
  });

  it('does not accept an installed model that cannot do the job it was chosen for', () => {
    const text = model({
      capabilities: ['completion', 'tools'],
      name: 'text-only',
      sizeGiB: 4,
    });
    const embedder = model({
      capabilities: ['embedding'],
      contextLength: 8192,
      name: 'embed-only',
      sizeGiB: 1,
    });
    const state = converged({
      installedModels: [...REAL_INVENTORY, text, embedder],
    });
    const wrongEmbedding = computePlan(state, { embeddingModel: 'text-only' });
    assert.match(
      describePlan(wrongEmbedding).join(' | '),
      /UNMET: The embedding model text-only cannot be used as one/,
    );
    assert.deepEqual(
      wrongEmbedding.actions,
      [],
      'nothing is pulled or rendered for it',
    );

    const wrongAgent = computePlan(
      converged({
        installedModels: [...REAL_INVENTORY, embedder],
        profiles: missing,
      }),
      { agentModel: 'embed-only' },
    );
    assert.match(
      describePlan(wrongAgent).join(' | '),
      /UNMET: The agent model embed-only cannot be used as one/,
    );
    assert.ok(
      !wrongAgent.actions.some((a) => a.kind === 'render-profiles'),
      'no profiles are generated for it',
    );
    // An agent needs tool calling and a context of 64k tokens, as in
    // models:recommend.
    const noTools = model({
      capabilities: ['completion'],
      contextLength: 131_072,
      name: 'no-tools',
      sizeGiB: 4,
    });
    const small = model({
      capabilities: ['completion', 'tools'],
      contextLength: 8192,
      name: 'small-context',
      sizeGiB: 4,
    });
    for (const [name, pattern] of [
      ['no-tools', /no tool-calling capability/],
      ['small-context', /context of 8192 tokens is below 65536/],
    ] as const) {
      const plan = computePlan(
        converged({
          installedModels: [...REAL_INVENTORY, noTools, small],
          profiles: missing,
        }),
        { agentModel: name },
      );
      assert.match(describePlan(plan).join(' | '), pattern, name);
      assert.ok(!plan.actions.some((a) => a.kind === 'render-profiles'));
    }
    // A model whose abilities are not reported is trusted.
    const unknown = model({ capabilities: [], name: 'mystery', sizeGiB: 2 });
    assert.deepEqual(
      computePlan(
        converged({ installedModels: [...REAL_INVENTORY, unknown] }),
        { embeddingModel: 'mystery' },
      ).unmet,
      [],
    );
  });

  it('matches model names however the inventory spells them', () => {
    const bare = [
      model({ capabilities: ['embedding'], name: 'bge-m3', sizeGiB: 1 }),
    ];
    assert.equal(isInstalled(bare, 'bge-m3'), true);
    assert.equal(isInstalled(bare, 'bge-m3:latest'), true);
    const plan = computePlan(
      converged({ installedModels: [...REAL_INVENTORY, ...bare] }),
      {
        embeddingModel: 'bge-m3:latest',
      },
    );
    assert.deepEqual(plan.actions, [], 'no second pull');
    const renamed = computePlan(
      converged({
        profiles: rendered({ agentModel: 'qwen3.6:35b-a3b-coding:latest' }),
      }),
      { agentModel: 'qwen3.6:35b-a3b-coding' },
    );
    assert.deepEqual(renamed.actions, []);
  });

  it('matches an installed model through its :latest tag', () => {
    assert.equal(isInstalled(REAL_INVENTORY, 'granite4.2'), true);
    assert.equal(isInstalled(REAL_INVENTORY, 'granite4.2:latest'), true);
    assert.equal(isInstalled(REAL_INVENTORY, 'bge-m3'), false);
  });
});
