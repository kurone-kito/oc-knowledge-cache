import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { machine, model, REAL_INVENTORY } from './fixtures.mts';
import { formatRecommendation } from './format.mts';
import { classifyFit, isSparse, recommendModels } from './recommend.mts';

const names = (list: ReadonlyArray<{ model: { name: string } }>): string[] =>
  list.map((entry) => entry.model.name);

describe('classifyFit', () => {
  it('puts a model that fits in VRAM on the GPU', () => {
    assert.equal(
      classifyFit(model({ name: 'a', sizeGiB: 4 }), machine(32, 8)),
      'gpu',
    );
  });

  it('spills a sparse model into RAM as offload', () => {
    const moe = model({ activeB: 3, name: 'moe', paramsB: 30, sizeGiB: 18 });
    assert.equal(classifyFit(moe, machine(64, 8)), 'offload');
  });

  it('runs a dense model that exceeds VRAM on the CPU tier', () => {
    assert.equal(
      classifyFit(model({ name: 'dense', sizeGiB: 12 }), machine(64, 8)),
      'cpu',
    );
  });

  it('returns undefined when the model fits nowhere', () => {
    assert.equal(
      classifyFit(model({ name: 'huge', sizeGiB: 80 }), machine(64, 8)),
      undefined,
    );
    assert.equal(
      classifyFit(model({ name: 'big', sizeGiB: 20 }), machine(16, 0)),
      undefined,
    );
  });

  it('treats unified memory as one pool', () => {
    // 32 GiB unified: the GPU may use 75% = 24 GiB, of which 95% = 22.8 GiB.
    const unified = machine(32, 24, true);
    assert.equal(
      classifyFit(model({ name: 'm', sizeGiB: 20 }), unified),
      'gpu',
    );
    assert.equal(
      classifyFit(model({ name: 'm', sizeGiB: 22 }), unified),
      undefined,
    );
  });
});

describe('isSparse', () => {
  it('requires few active parameters relative to the total', () => {
    assert.equal(
      isSparse(model({ activeB: 3, name: 'a', paramsB: 30, sizeGiB: 1 }), 8e9),
      true,
    );
    assert.equal(
      isSparse(model({ activeB: 20, name: 'a', paramsB: 30, sizeGiB: 1 }), 8e9),
      false,
    );
    assert.equal(
      isSparse(
        model({ activeB: 12, name: 'a', paramsB: 120, sizeGiB: 1 }),
        8e9,
      ),
      false,
    );
    assert.equal(isSparse(model({ name: 'dense', sizeGiB: 1 }), 8e9), false);
  });
});

describe('recommendModels for the agent role', () => {
  it('prefers the largest model that stays interactive', () => {
    const rec = recommendModels(machine(64, 8), [
      model({ name: 'small-gpu', paramsB: 4, sizeGiB: 3 }),
      model({ activeB: 3, name: 'big-moe', paramsB: 30, sizeGiB: 18 }),
      model({ name: 'dense-slow', paramsB: 40, sizeGiB: 24 }),
    ]);
    assert.deepEqual(names(rec.agent.candidates), [
      'big-moe',
      'small-gpu',
      'dense-slow',
    ]);
    assert.equal(rec.agent.best?.tier, 'offload');
    assert.equal(rec.agent.candidates[2]?.tier, 'cpu');
  });

  it('rejects models that cannot act as an agent, with a reason', () => {
    const rec = recommendModels(machine(64, 8), [
      model({ capabilities: ['completion'], name: 'no-tools', sizeGiB: 3 }),
      model({ contextLength: 32768, name: 'short', sizeGiB: 3 }),
      model({ capabilities: ['embedding'], name: 'embedder', sizeGiB: 1 }),
      model({ name: 'too-big', sizeGiB: 100 }),
      model({ name: 'ok', sizeGiB: 3 }),
    ]);
    assert.deepEqual(names(rec.agent.candidates), ['ok']);
    const reasons = Object.fromEntries(
      rec.agent.rejected.map((r) => [r.model.name, r.reason]),
    );
    assert.match(reasons['no-tools'] ?? '', /tool/);
    assert.match(reasons['short'] ?? '', /context 32768/);
    assert.match(reasons['embedder'] ?? '', /embedding/);
    assert.match(reasons['too-big'] ?? '', /does not fit/);
  });

  it('accepts a model whose context length is unknown', () => {
    const unknown = {
      ...model({ name: 'unknown-ctx', sizeGiB: 3 }),
      contextLength: undefined,
    };
    assert.equal(
      recommendModels(machine(32, 8), [unknown]).agent.best?.model.name,
      'unknown-ctx',
    );
  });

  it('breaks ties toward coding models, then by name, regardless of input order', () => {
    const a = model({ name: 'zzz-coding', paramsB: 8, sizeGiB: 3 });
    const b = model({ name: 'aaa-chat', paramsB: 8, sizeGiB: 3 });
    const c = model({ name: 'bbb-chat', paramsB: 8, sizeGiB: 3 });
    const forward = recommendModels(machine(32, 8), [a, b, c]);
    const backward = recommendModels(machine(32, 8), [c, b, a]);
    assert.deepEqual(names(forward.agent.candidates), [
      'zzz-coding',
      'aaa-chat',
      'bbb-chat',
    ]);
    assert.deepEqual(
      names(backward.agent.candidates),
      names(forward.agent.candidates),
    );
  });

  it('honors a different minimum context', () => {
    const m = model({ contextLength: 32768, name: 'short', sizeGiB: 3 });
    assert.equal(recommendModels(machine(32, 8), [m]).agent.best, undefined);
    assert.equal(
      recommendModels(machine(32, 8), [m], { minAgentContext: 16384 }).agent
        .best?.model.name,
      'short',
    );
  });

  it('works on a CPU-only machine', () => {
    const rec = recommendModels(machine(16, 0), [
      model({ name: 'dense-7b', paramsB: 7, sizeGiB: 4.5 }),
      model({ activeB: 3, name: 'moe-20b', paramsB: 20, sizeGiB: 8 }),
    ]);
    assert.deepEqual(names(rec.agent.candidates), ['moe-20b', 'dense-7b']);
    assert.deepEqual(
      rec.agent.candidates.map((c) => c.tier),
      ['offload', 'cpu'],
    );
  });
});

describe('recommendModels for the embedding role', () => {
  it('prefers multilingual models, then longer context', () => {
    const rec = recommendModels(machine(32, 8), [
      model({
        capabilities: ['embedding'],
        contextLength: 8192,
        name: 'all-minilm',
        sizeGiB: 0.1,
      }),
      model({
        capabilities: ['embedding'],
        contextLength: 512,
        name: 'nomic-embed-text-v2-moe',
        sizeGiB: 0.9,
      }),
      model({
        capabilities: ['embedding'],
        contextLength: 8192,
        name: 'bge-m3',
        sizeGiB: 1.1,
      }),
    ]);
    assert.deepEqual(names(rec.embedding.candidates), [
      'bge-m3',
      'nomic-embed-text-v2-moe',
      'all-minilm',
    ]);
  });

  it('never offers a chat model for embeddings', () => {
    const rec = recommendModels(machine(32, 8), [
      model({ name: 'chat', sizeGiB: 3 }),
    ]);
    assert.equal(rec.embedding.best, undefined);
  });
});

describe('pull suggestions', () => {
  it('suggests the best catalog model when nothing installed does the role', () => {
    const rec = recommendModels(machine(64, 8), []);
    assert.equal(rec.agent.best, undefined);
    assert.equal(
      rec.agent.pullSuggestion?.model.name,
      'gemma4:26b-a4b-it-q4_K_M',
    );
    assert.equal(rec.embedding.pullSuggestion?.model.name, 'bge-m3');
  });

  it('only suggests what fits the machine', () => {
    const rec = recommendModels(machine(10, 0), []);
    assert.equal(rec.agent.pullSuggestion?.model.name, 'gemma4:e2b-it-q4_K_M');
  });

  it('suggests nothing when even the smallest model does not fit', () => {
    assert.equal(
      recommendModels(machine(4, 0), []).agent.pullSuggestion,
      undefined,
    );
  });

  it('stays quiet when an installed model can do the role', () => {
    const rec = recommendModels(machine(64, 8), [
      model({ name: 'mine', sizeGiB: 3 }),
    ]);
    assert.equal(rec.agent.pullSuggestion, undefined);
  });
});

describe('recommendModels on a real inventory', () => {
  it('picks the big MoE model on 8 GiB VRAM and 64 GiB RAM', () => {
    const rec = recommendModels(machine(63.8, 8), REAL_INVENTORY);
    assert.equal(rec.agent.best?.model.name, 'qwen3.6:35b-a3b-coding');
    assert.equal(rec.agent.best?.tier, 'offload');
    assert.equal(
      rec.embedding.best?.model.name,
      'nomic-embed-text-v2-moe:latest',
    );
    assert.equal(rec.embedding.best?.tier, 'gpu');

    const rejected = names(rec.agent.rejected);
    assert.ok(
      rejected.includes('magistral:24b-small-2506-q4_K_M'),
      'context 40000 is too short',
    );
    assert.ok(rejected.includes('phi4:14b-q4_K_M'), 'phi4 has no tool calling');
    assert.ok(
      rejected.includes('tev1:4b-q4_K_M'),
      'tev1 only supports decision',
    );
  });

  it('falls back to small dense models on a 16 GiB laptop', () => {
    const rec = recommendModels(machine(16, 0), REAL_INVENTORY);
    assert.equal(rec.agent.best?.tier, 'cpu');
    assert.ok((rec.agent.best?.needBytes ?? Infinity) < 16 * 1024 ** 3 * 0.7);
  });

  it('renders a readable report', () => {
    const text = formatRecommendation(
      recommendModels(machine(63.8, 8), REAL_INVENTORY),
      2,
    );
    assert.match(text, /^Hardware: RAM 63\.8 GiB, Test GPU \(8\.0 GiB\)/);
    assert.match(text, /\* qwen3\.6:35b-a3b-coding {2}\[offload\]/);
    assert.match(text, /\(3\.0B active\)/);
    assert.match(text, /\.\.\. and \d+ more/);
  });
});
