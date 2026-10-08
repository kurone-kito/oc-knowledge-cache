import { type Action, describeAction, type Plan } from './plan.mts';

/** The side effects of a plan, injected so they can be tested. */
export interface ApplyDeps {
  pull(model: string, onProgress: (line: string) => void): Promise<void>;
  /** Generates the OpenClaw profiles; resolves with the files written. */
  render(agentModel: string): Promise<readonly string[]>;
  log(line: string): void;
}

export interface ApplyReport {
  /** Actions that were carried out. */
  readonly done: readonly Action[];
  /** Steps that only a person can do. */
  readonly manual: readonly Action[];
  readonly failed: readonly {
    readonly action: Action;
    readonly error: string;
  }[];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Carries out the automatic actions of a plan, in order. Manual steps are
 * collected, never run. Profiles are not generated when the pull of their
 * agent model failed, because they would name a model that is not there; a
 * failed embedding pull does not hold them back.
 */
export const applyPlan = async (
  plan: Plan,
  deps: ApplyDeps,
): Promise<ApplyReport> => {
  const done: Action[] = [];
  const manual: Action[] = [];
  const failed: { action: Action; error: string }[] = [];

  for (const action of plan.actions) {
    if (action.kind === 'manual') {
      manual.push(action);
      continue;
    }
    if (
      action.kind === 'render-profiles' &&
      failed.some(
        (f) =>
          f.action.kind === 'pull-model' &&
          f.action.role === 'agent' &&
          f.action.model === action.agentModel,
      )
    ) {
      deps.log(
        `skipped: ${describeAction(action)} (the agent model could not be pulled)`,
      );
      continue;
    }
    deps.log(`running: ${describeAction(action)}`);
    try {
      if (action.kind === 'pull-model') {
        await deps.pull(action.model, deps.log);
      } else {
        const written = await deps.render(action.agentModel);
        deps.log(`wrote ${written.length} files`);
      }
      done.push(action);
    } catch (error) {
      failed.push({ action, error: message(error) });
      deps.log(`failed: ${describeAction(action)}: ${message(error)}`);
    }
  }
  return { done, failed, manual };
};
