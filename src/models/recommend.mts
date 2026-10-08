import { PULL_CATALOG } from './catalog.mts';
import { acceleratorBytes } from './hardware.mts';
import {
  type FitTier,
  GIB,
  type Hardware,
  type ModelInfo,
  type Role,
} from './types.mts';

export interface RecommendOptions {
  /** Smallest context window an agent model may have (OpenClaw needs 64k). */
  readonly minAgentContext: number;
  /** Memory for the KV cache and compute buffers on top of the weights. */
  readonly overheadBytes: number;
  /** Share of GPU memory that models may fill. */
  readonly vramFraction: number;
  /** Share of system RAM that models may fill. */
  readonly ramFraction: number;
  /** A MoE model counts as "sparse" up to this many active parameters. */
  readonly sparseActiveLimit: number;
  /** Models to suggest pulling when nothing installed fits a role. */
  readonly catalog: readonly ModelInfo[];
}

export const DEFAULT_RECOMMEND_OPTIONS: RecommendOptions = {
  catalog: PULL_CATALOG,
  minAgentContext: 65_536,
  overheadBytes: 1.5 * GIB,
  ramFraction: 0.7,
  sparseActiveLimit: 8e9,
  vramFraction: 0.95,
};

export interface Candidate {
  readonly model: ModelInfo;
  readonly tier: FitTier;
  /** Weights plus working memory. */
  readonly needBytes: number;
}

export interface Rejection {
  readonly model: ModelInfo;
  readonly reason: string;
}

export interface RoleRecommendation {
  readonly role: Role;
  /** Installed candidates, best first. */
  readonly candidates: readonly Candidate[];
  readonly best: Candidate | undefined;
  readonly rejected: readonly Rejection[];
  /** Set only when no installed model can do the role. */
  readonly pullSuggestion: Candidate | undefined;
}

export interface Recommendation {
  readonly hardware: Hardware;
  readonly agent: RoleRecommendation;
  readonly embedding: RoleRecommendation;
}

const MULTILINGUAL =
  /bge-m3|embeddinggemma|qwen3-embedding|nomic-embed-text-v2|multilingual|e5/i;
const CODING = /cod(?:er|ing)/i;

/** True for mixture-of-experts models that activate few parameters per token. */
export const isSparse = (model: ModelInfo, limit: number): boolean => {
  const active = model.activeParameterCount;
  return (
    active !== undefined &&
    active <= limit &&
    (model.parameterCount === undefined || active * 2 <= model.parameterCount)
  );
};

/** Decides how a model fits the machine, or `undefined` when it does not. */
export const classifyFit = (
  model: ModelInfo,
  hardware: Hardware,
  options: RecommendOptions = DEFAULT_RECOMMEND_OPTIONS,
): FitTier | undefined => {
  const need = model.sizeBytes + options.overheadBytes;
  const vram = acceleratorBytes(hardware) * options.vramFraction;
  if (vram > 0 && need <= vram) {
    return 'gpu';
  }
  const ram = hardware.ramBytes * options.ramFraction;
  // With unified memory the GPU share is already part of the RAM.
  const pool = hardware.unifiedMemory ? Math.max(ram, vram) : ram + vram;
  if (need > pool) {
    return undefined;
  }
  return isSparse(model, options.sparseActiveLimit) ? 'offload' : 'cpu';
};

const ineligibility = (
  role: Role,
  model: ModelInfo,
  options: RecommendOptions,
): string | undefined => {
  if (role === 'embedding') {
    return model.capabilities.includes('embedding')
      ? undefined
      : 'not an embedding model';
  }
  if (model.capabilities.includes('embedding')) {
    return 'embedding model';
  }
  if (!model.capabilities.includes('completion')) {
    return 'cannot generate text';
  }
  if (!model.capabilities.includes('tools')) {
    return 'no tool-calling capability';
  }
  if (
    model.contextLength !== undefined &&
    model.contextLength < options.minAgentContext
  ) {
    return `context ${model.contextLength} is below ${options.minAgentContext}`;
  }
  return undefined;
};

/** `gpu` and `offload` are both interactive; `cpu` is slow. */
const speedClass = (tier: FitTier): number => (tier === 'cpu' ? 1 : 2);

const tierOrder = (tier: FitTier): number =>
  tier === 'gpu' ? 2 : tier === 'offload' ? 1 : 0;

const quality = (model: ModelInfo): number =>
  model.parameterCount ?? model.sizeBytes;

type Comparator = (a: Candidate, b: Candidate) => number;

const byName: Comparator = (a, b) => a.model.name.localeCompare(b.model.name);

/** Largest model that still runs at interactive speed wins. */
const agentOrder: Comparator = (a, b) =>
  speedClass(b.tier) - speedClass(a.tier) ||
  quality(b.model) - quality(a.model) ||
  Number(CODING.test(b.model.name)) - Number(CODING.test(a.model.name)) ||
  tierOrder(b.tier) - tierOrder(a.tier) ||
  byName(a, b);

/** Documents are Japanese: multilingual first, then long context. */
const embeddingOrder: Comparator = (a, b) =>
  Number(MULTILINGUAL.test(b.model.name)) -
    Number(MULTILINGUAL.test(a.model.name)) ||
  speedClass(b.tier) - speedClass(a.tier) ||
  (b.model.contextLength ?? 0) - (a.model.contextLength ?? 0) ||
  quality(b.model) - quality(a.model) ||
  byName(a, b);

const evaluate = (
  role: Role,
  hardware: Hardware,
  models: readonly ModelInfo[],
  options: RecommendOptions,
): { candidates: Candidate[]; rejected: Rejection[] } => {
  const candidates: Candidate[] = [];
  const rejected: Rejection[] = [];
  for (const model of models) {
    const reason = ineligibility(role, model, options);
    if (reason !== undefined) {
      rejected.push({ model, reason });
      continue;
    }
    const tier = classifyFit(model, hardware, options);
    if (tier === undefined) {
      rejected.push({ model, reason: 'does not fit in memory' });
      continue;
    }
    candidates.push({
      model,
      needBytes: model.sizeBytes + options.overheadBytes,
      tier,
    });
  }
  candidates.sort(role === 'agent' ? agentOrder : embeddingOrder);
  return { candidates, rejected };
};

const recommendRole = (
  role: Role,
  hardware: Hardware,
  installed: readonly ModelInfo[],
  options: RecommendOptions,
): RoleRecommendation => {
  const { candidates, rejected } = evaluate(role, hardware, installed, options);
  const best = candidates[0];
  if (best !== undefined) {
    return { best, candidates, pullSuggestion: undefined, rejected, role };
  }
  const installedNames = new Set(installed.map((model) => model.name));
  const suggestions = evaluate(
    role,
    hardware,
    options.catalog.filter((model) => !installedNames.has(model.name)),
    options,
  ).candidates;
  return {
    best,
    candidates,
    pullSuggestion: suggestions[0],
    rejected,
    role,
  };
};

/** Picks the agent and embedding models that suit the machine. */
export const recommendModels = (
  hardware: Hardware,
  installed: readonly ModelInfo[],
  overrides: Partial<RecommendOptions> = {},
): Recommendation => {
  const options = { ...DEFAULT_RECOMMEND_OPTIONS, ...overrides };
  return {
    agent: recommendRole('agent', hardware, installed, options),
    embedding: recommendRole('embedding', hardware, installed, options),
    hardware,
  };
};
