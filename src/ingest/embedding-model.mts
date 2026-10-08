import { recommendModels } from '../models/recommend.mts';
import type { Hardware, ModelInfo } from '../models/types.mts';

export interface EmbeddingChoice {
  readonly model: string;
  /** Context window in tokens, when the model is installed and reports one. */
  readonly contextLength: number | undefined;
  /** Why this model: asked for, already used by the store, or recommended. */
  readonly origin: 'requested' | 'store' | 'recommended';
}

export interface ChooseInput {
  /** Model named by the user (flag or environment). */
  readonly requested: string | undefined;
  /** Model the existing store was built with. */
  readonly storedModel: string | undefined;
  readonly installed: readonly ModelInfo[];
  readonly hardware: Hardware;
}

const findInstalled = (
  installed: readonly ModelInfo[],
  name: string,
): ModelInfo | undefined =>
  installed.find((model) => model.name === name) ??
  installed.find((model) => model.name === `${name}:latest`);

/**
 * Picks the embedding model for an ingestion. The model has to stay the same
 * for the life of a store, so an existing store decides unless the user asks
 * for a model explicitly (the store then refuses a mismatch).
 */
export const chooseEmbeddingModel = (input: ChooseInput): EmbeddingChoice => {
  const named = input.requested ?? input.storedModel;
  if (named !== undefined) {
    return {
      contextLength: findInstalled(input.installed, named)?.contextLength,
      model: named,
      origin: input.requested === undefined ? 'store' : 'requested',
    };
  }
  const { embedding } = recommendModels(input.hardware, input.installed);
  if (embedding.best !== undefined) {
    return {
      contextLength: embedding.best.model.contextLength,
      model: embedding.best.model.name,
      origin: 'recommended',
    };
  }
  const suggestion = embedding.pullSuggestion?.model.name ?? 'bge-m3';
  throw new Error(
    `No embedding model is installed. Pull one, for example: ollama pull ${suggestion}`,
  );
};
