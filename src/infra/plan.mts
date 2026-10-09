import {
  DEFAULT_RECOMMEND_OPTIONS,
  recommendModels,
} from '../models/recommend.mts';
import type { Hardware, ModelInfo, Role } from '../models/types.mts';
import { absolute, samePath } from '../openclaw/profiles.mts';

/** What is on disk where the OpenClaw profiles are generated. */
export interface RenderedProfiles {
  /**
   * Why the generated profiles cannot be used as they are (missing or broken
   * files, lost isolation properties); empty when they can.
   */
  readonly problems: readonly string[];
  /**
   * Obstructions that generating again cannot clear (a link, a file or a
   * folder where a generated file belongs, a path that cannot be examined):
   * each one is a step for a person.
   */
  readonly blockers?: readonly string[];
  /** Agent model both configs name; undefined when absent or they disagree. */
  readonly agentModel: string | undefined;
  /** Ollama URL both configs name; undefined when absent or they disagree. */
  readonly ollamaUrl: string | undefined;
  /** Working directory of the knowledge agent (the project repository). */
  readonly projectRepo: string | undefined;
  /**
   * Gateway ports of the configs, when both are known: a new generation keeps
   * them, so that start commands and clients stay valid.
   */
  readonly ports?: { readonly web: number; readonly knowledge: number };
}

/** What `provision` finds out about the machine. */
export interface MachineState {
  readonly hardware: Hardware;
  readonly ollamaReachable: boolean;
  /** Why the model list could not be read, when it could not. */
  readonly ollamaError?: string;
  /** Empty when Ollama is not reachable. */
  readonly installedModels: readonly ModelInfo[];
  /** Version line of the OpenClaw CLI, or undefined when it cannot be run. */
  readonly openclawVersion: string | undefined;
  readonly profiles: RenderedProfiles;
  /** Embedding model of an existing cache; it must not change. */
  readonly storeModel: string | undefined;
}

export interface PlanOptions {
  /** Agent model to use instead of the recommended one. */
  readonly agentModel?: string | undefined;
  /** Embedding model to use instead of the store's or the recommended one. */
  readonly embeddingModel?: string | undefined;
  /** Ollama URL the profiles must use; a different one is regenerated. */
  readonly ollamaUrl?: string | undefined;
  /** Repository the knowledge agent must work on; none when unset. */
  readonly projectRepo?: string | undefined;
}

export type Action =
  | {
      readonly kind: 'pull-model';
      readonly role: Role;
      readonly model: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'render-profiles';
      readonly agentModel: string;
      readonly reason: string;
    }
  /** A step that needs a person; it is printed, never run. */
  | {
      readonly kind: 'manual';
      readonly topic: 'start-ollama' | 'install-openclaw' | 'fix-profile-path';
      readonly instruction: string;
    };

export interface Plan {
  readonly actions: readonly Action[];
  readonly agentModel: string | undefined;
  readonly embeddingModel: string | undefined;
  /** Requirements that no action can meet; the machine is not provisioned. */
  readonly unmet: readonly string[];
}

/**
 * Why an installed model cannot do the job it was chosen for, or undefined.
 * The same rules as `models:recommend` applies to its own choices (an agent
 * needs text generation, tool calling and a context of at least 64k tokens),
 * except that what Ollama does not report is not held against the model.
 */
export const unfitReason = (
  role: Role,
  model: ModelInfo,
): string | undefined => {
  const abilities = model.capabilities;
  if (role === 'embedding') {
    return abilities.length === 0 || abilities.includes('embedding')
      ? undefined
      : `it offers ${abilities.join(', ')}, not embeddings`;
  }
  if (abilities.length > 0) {
    if (abilities.includes('embedding')) {
      return 'it is an embedding model';
    }
    if (!abilities.includes('completion')) {
      return 'it cannot generate text';
    }
    if (!abilities.includes('tools')) {
      return 'it has no tool-calling capability';
    }
  }
  const minimum = DEFAULT_RECOMMEND_OPTIONS.minAgentContext;
  if (model.contextLength !== undefined && model.contextLength < minimum) {
    return `its context of ${model.contextLength} tokens is below ${minimum}`;
  }
  return undefined;
};

/** Whether two model tags name the same model (`name` is `name:latest`). */
export const sameModel = (a: string, b: string): boolean =>
  a === b || a === `${b}:latest` || b === `${a}:latest`;

/** Whether a model tag is installed, under either spelling of its name. */
export const isInstalled = (
  installed: readonly ModelInfo[],
  name: string,
): boolean => installed.some((model) => sameModel(model.name, name));

const trimUrl = (url: string): string => url.replace(/\/+$/, '');

const describePath = (path: string | undefined): string =>
  path ?? 'no project repository';

/** Why the profiles must be generated again, or undefined when they are fine. */
const staleReason = (
  profiles: RenderedProfiles,
  agentModel: string,
  options: PlanOptions,
): string | undefined => {
  if (profiles.problems.length > 0) {
    return profiles.problems.join('; ');
  }
  if (
    profiles.agentModel === undefined ||
    !sameModel(profiles.agentModel, agentModel)
  ) {
    return `the profiles use ${profiles.agentModel ?? 'another model'}, not ${agentModel}`;
  }
  if (
    options.ollamaUrl !== undefined &&
    (profiles.ollamaUrl === undefined ||
      trimUrl(profiles.ollamaUrl) !== trimUrl(options.ollamaUrl))
  ) {
    return `the profiles use the Ollama server ${profiles.ollamaUrl ?? 'of another setup'}, not ${options.ollamaUrl}`;
  }
  const wanted =
    options.projectRepo === undefined
      ? undefined
      : absolute(options.projectRepo);
  const same =
    wanted === undefined || profiles.projectRepo === undefined
      ? wanted === profiles.projectRepo
      : samePath(wanted, profiles.projectRepo);
  if (!same) {
    return `the profiles work on ${describePath(profiles.projectRepo)}, not ${describePath(wanted)}`;
  }
  return undefined;
};

/**
 * Compares the machine with what the system needs and lists the steps that
 * would close the gap. Pure: it changes nothing, and a machine that already
 * has everything gets no actions.
 */
export const computePlan = (
  state: MachineState,
  options: PlanOptions = {},
): Plan => {
  const actions: Action[] = [];
  const unmet: string[] = [];
  const unfit = new Set<Role>();
  let agentModel = options.agentModel;
  // A cache keeps the exact name of its model: ingestion compares names
  // literally, so an equivalent spelling is not passed on.
  let embeddingModel = state.storeModel ?? options.embeddingModel;
  // A cache is bound to the model that made its vectors: asking for another
  // one cannot be met by pulling it, and ingestion would refuse the cache.
  if (
    options.embeddingModel !== undefined &&
    state.storeModel !== undefined &&
    !sameModel(options.embeddingModel, state.storeModel)
  ) {
    unmet.push(
      `The cache was built with ${state.storeModel}, so it cannot use ${options.embeddingModel}; keep that model, or choose a new data directory (--data) and ingest again.`,
    );
    embeddingModel = state.storeModel;
  }

  if (!state.ollamaReachable) {
    actions.push({
      // The server may be running and answer with an error: say what it said.
      instruction: `Install and start Ollama (https://ollama.com/download), or look at its log if it is running, then run the plan again.${
        state.ollamaError === undefined
          ? ''
          : ` The request for its model list failed: ${state.ollamaError}`
      }`,
      kind: 'manual',
      topic: 'start-ollama',
    });
  } else {
    const recommendation = recommendModels(
      state.hardware,
      state.installedModels,
    );
    agentModel ??=
      recommendation.agent.best?.model.name ??
      recommendation.agent.pullSuggestion?.model.name;
    embeddingModel ??=
      recommendation.embedding.best?.model.name ??
      recommendation.embedding.pullSuggestion?.model.name;

    for (const [role, model] of [
      ['agent', agentModel],
      ['embedding', embeddingModel],
    ] as const) {
      if (model === undefined) {
        unmet.push(
          `No ${role} model fits this machine; pass one explicitly or free up memory.`,
        );
      } else if (!isInstalled(state.installedModels, model)) {
        // Two roles may name the same tag: one pull serves both.
        if (
          actions.some(
            (a) => a.kind === 'pull-model' && sameModel(a.model, model),
          )
        ) {
          continue;
        }
        actions.push({
          kind: 'pull-model',
          model,
          reason: `the ${role} model is not installed`,
          role,
        });
      } else {
        // Present is not enough: it has to be able to do the job. Models whose
        // capabilities Ollama does not report are given the benefit of the doubt.
        const installed = state.installedModels.find((m) =>
          sameModel(m.name, model),
        );
        const why =
          installed === undefined ? undefined : unfitReason(role, installed);
        if (why !== undefined) {
          unfit.add(role);
          unmet.push(
            `The ${role} model ${model} cannot be used as one: ${why}; choose another with --${role === 'agent' ? 'agent' : 'embed'}-model.`,
          );
        }
      }
    }
  }

  if (state.openclawVersion === undefined) {
    actions.push({
      instruction:
        'Install OpenClaw (see https://docs.openclaw.ai, for example "npm install -g openclaw"); this tool does not install it for you.',
      kind: 'manual',
      topic: 'install-openclaw',
    });
  }

  // Something in the way of the generated files is cleared by a person; the
  // profiles are not generated over it.
  const blockers = state.profiles.blockers ?? [];
  for (const blocker of blockers) {
    actions.push({
      instruction: blocker,
      kind: 'manual',
      topic: 'fix-profile-path',
    });
  }

  // Profiles name a model and a server: only generate them once Ollama is
  // reachable and the model is installed or about to be pulled by this plan.
  if (
    state.ollamaReachable &&
    agentModel !== undefined &&
    !unfit.has('agent') &&
    blockers.length === 0
  ) {
    const reason = staleReason(state.profiles, agentModel, options);
    if (reason !== undefined) {
      actions.push({ agentModel, kind: 'render-profiles', reason });
    }
  }

  return { actions, agentModel, embeddingModel, unmet };
};

/** Human-readable lines for a plan. */
export const describeAction = (action: Action): string => {
  if (action.kind === 'pull-model') {
    return `pull ${action.model} (${action.reason})`;
  }
  if (action.kind === 'render-profiles') {
    return `generate the OpenClaw profiles for ${action.agentModel} (${action.reason})`;
  }
  return `MANUAL: ${action.instruction}`;
};

/**
 * A line to print under a plan whose models are not known: the reason must be
 * the real one (a server that is up but failed is not "not running"). Nothing
 * when the models are known or none was asked for.
 */
export const modelsUnknownNote = (
  state: MachineState,
  plan: Plan,
): string | undefined => {
  if (state.ollamaReachable || plan.agentModel === undefined) {
    return undefined;
  }
  return state.ollamaError === undefined
    ? '(models are unknown while Ollama is not running)'
    : '(models are unknown: the model list of Ollama could not be read)';
};

export const describePlan = (plan: Plan): string[] => [
  ...plan.actions.map(describeAction),
  ...plan.unmet.map((requirement) => `UNMET: ${requirement}`),
];
