import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { machine, model } from '../models/fixtures.mts';
import { chooseEmbeddingModel } from './embedding-model.mts';

const embedder = (name: string, contextLength = 512) => ({
  ...model({ capabilities: ['embedding'], contextLength, name, sizeGiB: 0.5 }),
});

const hardware = machine(32, 8);

describe('chooseEmbeddingModel', () => {
  it('prefers a model the user asked for', () => {
    const choice = chooseEmbeddingModel({
      hardware,
      installed: [embedder('bge-m3', 8192), embedder('all-minilm', 256)],
      requested: 'all-minilm',
      storedModel: 'bge-m3',
    });
    assert.deepEqual(choice, {
      contextLength: 256,
      model: 'all-minilm',
      origin: 'requested',
    });
  });

  it('keeps the model of an existing store', () => {
    const choice = chooseEmbeddingModel({
      hardware,
      installed: [
        embedder('bge-m3', 8192),
        embedder('nomic-embed-text-v2-moe:latest'),
      ],
      requested: undefined,
      storedModel: 'nomic-embed-text-v2-moe:latest',
    });
    assert.equal(choice.model, 'nomic-embed-text-v2-moe:latest');
    assert.equal(choice.origin, 'store');
    assert.equal(choice.contextLength, 512);
  });

  it('finds an installed model through its :latest tag', () => {
    const choice = chooseEmbeddingModel({
      hardware,
      installed: [embedder('bge-m3:latest', 8192)],
      requested: 'bge-m3',
      storedModel: undefined,
    });
    assert.equal(choice.contextLength, 8192);
  });

  it('recommends an installed embedding model for a new store', () => {
    const choice = chooseEmbeddingModel({
      hardware,
      installed: [
        model({ name: 'chat-model', sizeGiB: 4 }),
        embedder('all-minilm', 256),
        embedder('bge-m3', 8192),
      ],
      requested: undefined,
      storedModel: undefined,
    });
    assert.deepEqual(choice, {
      contextLength: 8192,
      model: 'bge-m3',
      origin: 'recommended',
    });
  });

  it('reports a context length of undefined for a model that is not installed', () => {
    const choice = chooseEmbeddingModel({
      hardware,
      installed: [],
      requested: 'remote-model',
      storedModel: undefined,
    });
    assert.equal(choice.contextLength, undefined);
  });

  it('explains how to get an embedding model when there is none', () => {
    assert.throws(
      () =>
        chooseEmbeddingModel({
          hardware,
          installed: [model({ name: 'chat-model', sizeGiB: 4 })],
          requested: undefined,
          storedModel: undefined,
        }),
      /ollama pull bge-m3/,
    );
  });
});
