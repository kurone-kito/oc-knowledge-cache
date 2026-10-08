import { join } from 'node:path';
import { realPathOf } from '../openclaw/paths.mts';
import {
  absolute,
  buildProfiles,
  checkProfiles,
  DEFAULT_PORTS,
  MIN_PORT_SPACING,
  type OpenClawConfig,
  type ProfileName,
  type ProfileSet,
  posix,
} from '../openclaw/profiles.mts';
import {
  hasName,
  jsonText,
  linkProblems,
  renderSkillFile,
} from '../openclaw/write.mts';
import { type RenderedProfiles, sameModel } from './plan.mts';

/** Where the profiles are and what they must not overlap. */
export interface InspectPaths {
  readonly outDir: string;
  readonly dataDir: string;
  /** This repository; when given, the knowledge skill must point at it. */
  readonly repoRoot?: string;
}

/** The files `inspectProfiles` reads; `undefined` when a file does not exist. */
export type ReadText = (path: string) => Promise<string | undefined>;

const MODEL_PREFIX = 'ollama/';
const NAMES: readonly ProfileName[] = ['web', 'knowledge'];

const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      typeof current === 'object' && current !== null
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const parseConfig = (
  source: string | undefined,
): OpenClawConfig | undefined => {
  try {
    const parsed: unknown = JSON.parse(source ?? 'null');
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as OpenClawConfig)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The one value all entries agree on, or undefined. */
const agreed = (
  values: readonly (string | undefined)[],
  same: (a: string, b: string) => boolean = (a, b) => a === b,
): string | undefined =>
  values.every(
    (value) => value !== undefined && same(value, values[0] as string),
  )
    ? values[0]
    : undefined;

const trimUrl = (url: string): string => url.replace(/[/]+$/, '');

const modelOf = (config: OpenClawConfig | undefined): string | undefined => {
  const primary = text(field(config, 'agents', 'defaults', 'model', 'primary'));
  return primary?.startsWith(MODEL_PREFIX)
    ? primary.slice(MODEL_PREFIX.length)
    : undefined;
};

const portOf = (config: OpenClawConfig | undefined): number | undefined => {
  const port = field(config, 'gateway', 'port');
  return Number.isInteger(port) ? (port as number) : undefined;
};

/**
 * Looks at both generated profiles: the configs, the skills they rely on and
 * the isolation properties that make them a trust boundary. Everything that a
 * new generation would repair is reported as a problem; nothing else (for
 * example the ports, or settings added by hand) is judged.
 */
export const inspectProfiles = async (
  requested: InspectPaths,
  readFileText: ReadText,
  listFolders: (path: string) => Promise<string[]> = async () => [],
): Promise<RenderedProfiles> => {
  // Something that is not a readable file where a file belongs (a folder, a
  // file in the place of a parent folder) is a problem to report, not a crash.
  const unreadable: string[] = [];
  const listDirectories = async (path: string): Promise<string[]> => {
    try {
      return await listFolders(path);
    } catch (error) {
      unreadable.push(
        `${path} cannot be listed as a folder (${(error as NodeJS.ErrnoException).code ?? 'error'}); remove or move it`,
      );
      return [];
    }
  };
  const readText: ReadText = async (path) => {
    try {
      return await readFileText(path);
    } catch (error) {
      unreadable.push(
        `${path} cannot be read as a file (${(error as NodeJS.ErrnoException).code ?? 'error'}); remove or move it`,
      );
      return undefined;
    }
  };
  // A generation writes the real locations (links and short names resolved)
  // into the configs: look at them the same way.
  const paths = {
    dataDir: await realPathOf(requested.dataDir),
    outDir: await realPathOf(requested.outDir),
  };
  const sources = await Promise.all(
    NAMES.map((name) => readText(join(paths.outDir, name, 'openclaw.json'))),
  );
  if (sources.every((source) => source === undefined)) {
    return {
      agentModel: undefined,
      ollamaUrl: undefined,
      problems: [
        'the OpenClaw profiles have not been generated',
        ...unreadable,
      ],
      projectRepo: undefined,
    };
  }

  const problems: string[] = [];
  const configs = sources.map(parseConfig);
  NAMES.forEach((name, index) => {
    if (sources[index] === undefined) {
      problems.push(`the ${name} profile has no openclaw.json`);
    } else if (configs[index] === undefined) {
      problems.push(`the ${name} openclaw.json is not a JSON object`);
    }
  });
  const [web, knowledge] = configs;
  // A port that is missing or not a number leaves a gateway that cannot start.
  // (Which valid port it is, is nobody's business here.)
  NAMES.forEach((name, index) => {
    const config = configs[index];
    const port = portOf(config);
    if (config !== undefined && port === undefined) {
      problems.push(`the ${name} gateway has no valid port`);
    } else if (
      port !== undefined &&
      (port < 1024 || port + MIN_PORT_SPACING > 65_535)
    ) {
      // The range a generation accepts; any port inside it is the user's.
      problems.push(`the ${name} gateway port ${port} is not usable`);
    }
  });
  // The project directory counts where it really is, like the other folders.
  const rawCwd = field(knowledge, 'agents', 'entries', 'knowledge', 'cwd');
  if (rawCwd !== undefined && typeof rawCwd !== 'string') {
    problems.push(
      'the knowledge agent has a project directory that is not text',
    );
  }
  const cwd = text(rawCwd);
  let projectRepo: string | undefined;
  if (cwd !== undefined) {
    try {
      projectRepo = absolute(await realPathOf(cwd));
    } catch {
      // A loop of links, for example: the profile is broken, and a generation
      // takes the directory that was asked for.
      problems.push(`the project directory ${cwd} cannot be resolved`);
    }
  }

  // The layout (paths, skills) comes from a template built the way a
  // generation builds it; the configs on disk take the place of the template's.
  // Ports are not judged here (people set them by hand): the template has
  // the defaults, and the configs' own ports are only reported for a new
  // generation to keep, when a generation would accept them.
  const templateFor = (ports: {
    readonly web: number;
    readonly knowledge: number;
  }): ProfileSet =>
    buildProfiles({
      dataDir: paths.dataDir,
      model: 'template',
      ollamaUrl: 'http://127.0.0.1:11434',
      outDir: paths.outDir,
      ports,
      repoRoot: paths.outDir,
      tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
    });
  let template: ProfileSet | undefined;
  try {
    template = templateFor(DEFAULT_PORTS);
  } catch (error) {
    problems.push(
      `the profiles cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (template !== undefined) {
    for (const profile of [template.web, template.knowledge]) {
      // `readText` follows links: a config or skill that is only a link to
      // something valid-looking must not count as the profile's own.
      try {
        problems.push(...(await linkProblems(profile)));
      } catch (error) {
        problems.push(
          `the ${profile.name} profile cannot be examined (${(error as NodeJS.ErrnoException).code ?? 'error'}); fix the permissions of ${profile.dir}`,
        );
      }
      // A skill of this repository that the profile must not have, left over
      // in its workspace, is cache-specific text in the wrong place.
      const known = new Set([
        ...template.web.skills,
        ...template.knowledge.skills,
      ]);
      // The state folder is made by OpenClaw later; if something that is not
      // a folder stands there, listing it reports it (a missing one is fine).
      await listDirectories(profile.stateDir);
      for (const name of await listDirectories(
        join(profile.workspace, 'skills'),
      )) {
        if (hasName([...known], name) && !hasName(profile.skills, name)) {
          problems.push(
            `the ${profile.name} workspace still holds the ${name} skill`,
          );
        }
      }
      for (const skill of profile.skills) {
        const file = join(profile.workspace, 'skills', skill, 'SKILL.md');
        const content = await readText(file);
        if (content === undefined) {
          problems.push(`the ${profile.name} profile lacks the ${skill} skill`);
        } else if (profile.name === 'knowledge') {
          // The skill carries the paths of the cache and of this repository,
          // in the exact places where the generator writes them (see the
          // skill's source): a longer path that merely starts with the right
          // one does not count.
          const expected = [
            [
              'data directory',
              paths.dataDir,
              '"KC_DATA_DIR": "',
              '"',
              jsonText,
            ],
            ['repository', requested.repoRoot, '"workdir": "', '"', jsonText],
            [
              'Ollama server',
              text(
                field(knowledge, 'models', 'providers', 'ollama', 'baseUrl'),
              ),
              '"OLLAMA_HOST": "',
              '"',
              jsonText,
            ],
          ] as const;
          for (const [what, path, before, after, quote] of expected) {
            if (
              path !== undefined &&
              !content.includes(`${before}${quote(posix(path))}${after}`)
            ) {
              problems.push(`the ${skill} skill points at another ${what}`);
            }
          }
        }
        // Where the repository's source is known, the skill must be exactly
        // what a generation writes from it: an edited or stale skill is
        // restored.
        if (content !== undefined && requested.repoRoot !== undefined) {
          const source = await readText(
            join(requested.repoRoot, 'openclaw', 'skills', skill, 'SKILL.md'),
          );
          if (source !== undefined) {
            const url =
              text(
                field(
                  configs[NAMES.indexOf(profile.name)],
                  'models',
                  'providers',
                  'ollama',
                  'baseUrl',
                ),
              ) ?? '';
            const expected = renderSkillFile(
              source,
              { dataDir: paths.dataDir, repoRoot: requested.repoRoot },
              url,
            );
            if (content !== expected) {
              problems.push(
                `the ${profile.name} profile's ${skill} skill differs from the repository's`,
              );
            }
          }
        }
      }
    }
    if (web !== undefined && knowledge !== undefined) {
      problems.push(
        ...checkProfiles(
          {
            knowledge: { ...template.knowledge, config: knowledge },
            web: { ...template.web, config: web },
          },
          // The inspected project repository must not reach a profile either.
          {
            dataDir: paths.dataDir,
            projectRepo,
          },
        ),
      );
    }
  }

  const webPort = portOf(web);
  const knowledgePort = portOf(knowledge);
  // Keep what can be kept: both ports, else the one that works with the
  // other gateway's default. Ports a generation would refuse are not kept.
  const candidates = [
    { knowledge: knowledgePort, web: webPort },
    { knowledge: undefined, web: webPort },
    { knowledge: knowledgePort, web: undefined },
  ];
  let keptPorts: { knowledge: number; web: number } | undefined;
  let pairRefused = false;
  for (const candidate of candidates) {
    if (candidate.web === undefined && candidate.knowledge === undefined) {
      continue;
    }
    const ports = {
      knowledge: candidate.knowledge ?? DEFAULT_PORTS.knowledge,
      web: candidate.web ?? DEFAULT_PORTS.web,
    };
    try {
      templateFor(ports);
      keptPorts = ports;
      break;
    } catch {
      // Try the next, smaller choice.
      pairRefused ||=
        candidate.web !== undefined && candidate.knowledge !== undefined;
    }
  }
  // Two ports that are fine alone but too close together would let the
  // derived browser ports of the gateways collide: that is repaired as well.
  const usable = (port: number | undefined): boolean =>
    port !== undefined && port >= 1024 && port + MIN_PORT_SPACING <= 65_535;
  if (pairRefused && usable(webPort) && usable(knowledgePort)) {
    problems.push(
      `the gateway ports ${webPort} and ${knowledgePort} are closer than ${MIN_PORT_SPACING}, so their derived ports could collide`,
    );
  }

  const agentModel = agreed(configs.map(modelOf), sameModel);
  if (
    web !== undefined &&
    knowledge !== undefined &&
    agentModel === undefined
  ) {
    problems.push('the profiles do not name one and the same agent model');
  }
  // What the agent really runs: its own entry may override the default, and
  // the provider must still define the model that is named.
  if (agentModel !== undefined && template !== undefined) {
    for (const profile of [template.web, template.knowledge]) {
      const config = configs[NAMES.indexOf(profile.name)];
      const own = field(config, 'agents', 'entries', profile.agentId, 'model');
      const primary = typeof own === 'string' ? own : field(own, 'primary');
      // Only a missing setting inherits the default: a present one must be a
      // model name, or an object with one as its primary (not a number, not an
      // empty object).
      const malformed =
        own !== undefined &&
        typeof own !== 'string' &&
        (typeof own !== 'object' ||
          own === null ||
          Array.isArray(own) ||
          typeof primary !== 'string');
      if (malformed) {
        problems.push(
          `the ${profile.name} agent has a model setting that is not valid`,
        );
      } else if (
        typeof primary === 'string' &&
        !(
          primary.startsWith(MODEL_PREFIX) &&
          // Compared with this profile's own default, not with the other's.
          sameModel(
            primary.slice(MODEL_PREFIX.length),
            modelOf(config) ?? agentModel,
          )
        )
      ) {
        problems.push(
          `the ${profile.name} agent runs ${primary}, not the profile's model`,
        );
      }
      // Each config must define the model that it names itself.
      const named = modelOf(config) ?? agentModel;
      const defined = field(config, 'models', 'providers', 'ollama', 'models');
      if (
        !Array.isArray(defined) ||
        !defined.some((entry) => text(field(entry, 'id')) === named)
      ) {
        problems.push(
          `the ${profile.name} provider does not define the model ${named}`,
        );
      }
    }
  }
  const ollamaUrl = agreed(
    configs.map((config) =>
      text(field(config, 'models', 'providers', 'ollama', 'baseUrl')),
    ),
    (a, b) => trimUrl(a) === trimUrl(b),
  );
  return {
    agentModel,
    ollamaUrl: ollamaUrl === undefined ? undefined : trimUrl(ollamaUrl),
    // Unreadable paths are collected as the files are read, until the end.
    problems: [...problems, ...unreadable],
    projectRepo,
    ...(keptPorts === undefined ? {} : { ports: keptPorts }),
  };
};
