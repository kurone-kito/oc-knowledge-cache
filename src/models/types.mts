/** Bytes in one gibibyte. */
export const GIB = 1024 ** 3;

/** What a model is used for in this system. */
export type Role = 'agent' | 'embedding';

/**
 * How well a model fits the machine.
 *
 * - `gpu`: weights and working memory fit in GPU memory (fast).
 * - `offload`: a sparse mixture-of-experts model that spills into system RAM;
 *   only a few experts are active per token, so it stays interactive.
 * - `cpu`: a dense model that needs system RAM (slow).
 */
export type FitTier = 'gpu' | 'offload' | 'cpu';

export interface GpuInfo {
  readonly name: string;
  readonly vramBytes: number;
}

export interface Hardware {
  readonly ramBytes: number;
  readonly gpus: readonly GpuInfo[];
  /** CPU and GPU share one memory pool (Apple Silicon). */
  readonly unifiedMemory: boolean;
}

/** The facts about an Ollama model that the recommendation needs. */
export interface ModelInfo {
  readonly name: string;
  /** Size of the weights on disk, which approximates the memory they need. */
  readonly sizeBytes: number;
  readonly parameterCount: number | undefined;
  /** Parameters used per token; differs from the total for MoE models. */
  readonly activeParameterCount: number | undefined;
  readonly contextLength: number | undefined;
  /** Ollama capabilities such as `completion`, `tools` or `embedding`. */
  readonly capabilities: readonly string[];
}
