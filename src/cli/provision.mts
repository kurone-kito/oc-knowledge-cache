import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type ApplyReport, applyPlan } from '../infra/apply.mts';
import {
  computePlan,
  describeAction,
  describePlan,
  type MachineState,
  type Plan,
  sameModel,
  unfitReason,
} from '../infra/plan.mts';
import { pullModel } from '../infra/pull.mts';
import { gatherState, systemProbe } from '../infra/state.mts';
import {
  listInstalledModels,
  resolveOllamaBaseUrl,
} from '../models/ollama.mts';
import type { ModelInfo } from '../models/types.mts';
import { generateProfiles, layoutProblem } from '../openclaw/generate.mts';
import { realPathOf } from '../openclaw/paths.mts';
import { DEFAULT_CONTEXT_WINDOW } from '../openclaw/profiles.mts';
import { startCommands } from '../openclaw/shell.mts';
import { optionalNumber, resolveDataDir, scriptArgs } from './options.mts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const USAGE = `Usage: pnpm run provision [plan|apply] [options]

Brings this machine to the state the system needs, and does nothing on a
machine that is already there.

  plan    show what is missing (default); changes nothing
  apply   carry out the automatic steps: pull the recommended agent and
          embedding models, and generate the OpenClaw profiles

Starting Ollama and installing OpenClaw are never done for you; the plan
prints them as MANUAL steps. Pass the same --out, --data, --project-repo and
--ollama-url every time: profiles that differ from them are generated again.
Exit status:
  plan            0 after showing the plan, whatever it contains
  plan --check    0 when the machine is provisioned, 2 when it is not
  apply           0 when the machine is provisioned afterwards, 2 when it is
                  not (something is missing, failed or unmet)
  any command     1 when the command could not run

Options:
  --out <dir>           where the OpenClaw profiles go (default .openclaw)
  --data <dir>          data directory with the cache
                        (default $KC_DATA_DIR, else .data)
  --project-repo <dir>  repository the knowledge agent works on
  --agent-model <tag>   use this agent model instead of the recommended one
  --embed-model <tag>   use this embedding model (default: the cache's, else
                        the recommended one)
  --ollama-url <url>    Ollama server (default: $OLLAMA_HOST or 127.0.0.1:11434)
  --pull-idle-timeout <seconds>
                        give up a model pull after this long without data
                        (default 120)
  --ram-gib <n>         memory of the machine that runs Ollama, when it is not
                        this one (used to choose the models)
  --vram-gib <n>        GPU memory of that machine (0 = no GPU)
  --unified-memory      GPU and CPU of that machine share one memory pool
  --check               with plan: exit with status 2 when anything is missing
  -h, --help            show this help
`;

const print = (lines: readonly string[]): void => {
  process.stdout.write(`${lines.join('\n')}\n`);
};

const contextWindowOf = (
  state: MachineState,
  model: string,
): number | undefined => {
  const installed = state.installedModels.find((m) => sameModel(m.name, model));
  return installed?.contextLength === undefined
    ? undefined
    : Math.min(installed.contextLength, DEFAULT_CONTEXT_WINDOW);
};

/** The model list, asked for up to three times. */
const listWithRetry = async (baseUrl: string): Promise<ModelInfo[]> => {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await listInstalledModels({
        baseUrl,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw last;
};

const report = (plan: Plan, state: MachineState): number => {
  if (plan.actions.length === 0 && plan.unmet.length === 0) {
    print([
      'Nothing to do: the machine already has the models, the OpenClaw CLI and the profiles.',
    ]);
    return 0;
  }
  print([
    ...describePlan(plan),
    ...(state.ollamaReachable || plan.agentModel === undefined
      ? []
      : ['(models are unknown while Ollama is not running)']),
  ]);
  return 0;
};

const main = async (): Promise<number> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: scriptArgs(process.argv.slice(2)),
    options: {
      'agent-model': { type: 'string' },
      check: { type: 'boolean' },
      data: { type: 'string' },
      'embed-model': { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      'ollama-url': { type: 'string' },
      out: { type: 'string' },
      'pull-idle-timeout': { type: 'string' },
      'project-repo': { type: 'string' },
      'ram-gib': { type: 'string' },
      'unified-memory': { type: 'boolean' },
      'vram-gib': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const command = positionals[0] ?? 'plan';
  if ((command !== 'plan' && command !== 'apply') || positionals.length > 1) {
    process.stderr.write(
      `Unknown command "${positionals.join(' ')}"\n\n${USAGE}`,
    );
    return 1;
  }

  const baseUrl = resolveOllamaBaseUrl(
    values['ollama-url'] ?? process.env['OLLAMA_HOST'],
  );
  // Where the files really end up, so that a link cannot hide an overlap and
  // the inspection expects what the generation writes.
  const outDir = await realPathOf(values.out ?? '.openclaw');
  // The same choice as ingest and kc:search: the option, else $KC_DATA_DIR,
  // else .data.
  const dataDir = await realPathOf(resolveDataDir(values.data));
  const projectRepo =
    values['project-repo'] === undefined
      ? undefined
      : await realPathOf(values['project-repo']);
  const paths = { dataDir, outDir, repoRoot: REPO_ROOT };
  // Folders that could never hold isolated profiles are a mistake in the
  // command, not a step to plan.
  const layout = layoutProblem({
    dataDir,
    model: 'layout-check',
    ollamaUrl: baseUrl,
    outDir,
    projectRepo,
    repoRoot: REPO_ROOT,
  });
  if (layout !== undefined) {
    process.stderr.write(`The folders cannot be used:\n${layout}\n`);
    return 1;
  }
  const idleSeconds = optionalNumber(
    'pull-idle-timeout',
    values['pull-idle-timeout'],
    { min: 1 },
  );
  const hardware = {
    ramGiB: optionalNumber('ram-gib', values['ram-gib'], { min: 1 }),
    unifiedMemory: values['unified-memory'],
    vramGiB: optionalNumber('vram-gib', values['vram-gib']),
  };
  const options = {
    agentModel: values['agent-model'],
    embeddingModel: values['embed-model'],
    ollamaUrl: baseUrl,
    projectRepo,
  };

  const state = await gatherState(paths, systemProbe(baseUrl, hardware));
  const plan = computePlan(state, options);
  if (command === 'plan') {
    const code = report(plan, state);
    return values.check && (plan.actions.length > 0 || plan.unmet.length > 0)
      ? 2
      : code;
  }

  const result: ApplyReport = await applyPlan(plan, {
    log: (line) => print([line]),
    pull: (model, onProgress) =>
      pullModel({
        baseUrl,
        model,
        onProgress,
        ...(idleSeconds === undefined
          ? {}
          : { idleTimeoutMs: idleSeconds * 1000 }),
      }),
    render: async (agentModel) => {
      // Ask for what is there now: the model may have been pulled a moment
      // ago, and the server must be reachable and list it, or the context
      // window would be a guess. Otherwise the step fails and a later run
      // repeats it.
      let installedNow: ModelInfo[];
      try {
        installedNow = await listWithRetry(baseUrl);
      } catch (error) {
        throw new Error(
          `Cannot read the model list of ${baseUrl} to generate the profiles: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const listed = installedNow.find((m) => sameModel(m.name, agentModel));
      if (listed === undefined) {
        throw new Error(
          `Ollama does not list ${agentModel} (yet); the profiles are generated by the next run`,
        );
      }
      // What was pulled has to be able to act as the agent, or the profiles
      // would name a model that cannot run them.
      const why = unfitReason('agent', listed);
      if (why !== undefined) {
        throw new Error(
          `${agentModel} cannot be the agent model: ${why}; choose another with --agent-model`,
        );
      }
      const contextWindow = contextWindowOf(
        { ...state, installedModels: installedNow },
        agentModel,
      );
      const { set, written } = await generateProfiles({
        dataDir,
        model: agentModel,
        ollamaUrl: baseUrl,
        outDir,
        projectRepo: options.projectRepo,
        // Keep the ports the profiles already use.
        ...(state.profiles.ports === undefined
          ? {}
          : { ports: state.profiles.ports }),
        repoRoot: REPO_ROOT,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      });
      print([
        'Start the gateways with these commands (one terminal each):',
        ...startCommands(set.web),
        ...startCommands(set.knowledge),
      ]);
      return written;
    },
  });

  // Look again: only the manual steps should be left.
  const after = computePlan(
    await gatherState(paths, systemProbe(baseUrl, hardware)),
    options,
  );
  print([
    '',
    `${result.done.length} step(s) done, ${result.failed.length} failed.`,
    ...after.actions.map((action) =>
      action.kind === 'manual'
        ? describeAction(action)
        : `still to do: ${describeAction(action)}`,
    ),
    ...after.unmet.map((requirement) => `UNMET: ${requirement}`),
  ]);
  // Provisioned means nothing is left for anyone to do.
  return result.failed.length > 0 ||
    after.actions.length > 0 ||
    after.unmet.length > 0
    ? 2
    : 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `provision failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
