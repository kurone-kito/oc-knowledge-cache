import { join, resolve } from 'node:path';

/**
 * The two OpenClaw instances of this system, as isolated profiles:
 *
 * - `web`: researches on the Internet. It never sees the NAS, the data
 *   directory or the knowledge cache, so nothing derived from them can reach
 *   a process that talks to the Internet.
 * - `knowledge`: answers from the cache and works on the project repository.
 *   It has no web tools.
 *
 * The configuration keys were checked against `openclaw config validate` of
 * OpenClaw 2026.9.9, but never against a running gateway.
 */
export type ProfileName = 'web' | 'knowledge';

export interface ProfileInput {
  /** Directory that receives one sub-directory per profile. */
  readonly outDir: string;
  /** This repository: it holds the scripts the knowledge skill runs. */
  readonly repoRoot: string;
  /** Data directory with `store.sqlite`; only the knowledge profile uses it. */
  readonly dataDir: string;
  /** Repository the knowledge agent works on; its own workspace when unset. */
  readonly projectRepo?: string | undefined;
  /** Native Ollama URL, without `/v1` (which breaks tool calling). */
  readonly ollamaUrl: string;
  /** Ollama model tag for the agents, e.g. `qwen3.6:35b-a3b-coding`. */
  readonly model: string;
  /** Model context window; the default suits the memory of a small GPU. */
  readonly contextWindow?: number | undefined;
  /** Gateway base ports; derived ports need about 120 free above each. */
  readonly ports?: { readonly web: number; readonly knowledge: number };
  /** Shared secrets for the two gateways (never reused between them). */
  readonly tokens: { readonly web: string; readonly knowledge: string };
}

/** The shape of a generated `openclaw.json`; kept loose on purpose. */
export type OpenClawConfig = Record<string, unknown>;

export interface OpenClawProfile {
  readonly name: ProfileName;
  readonly agentId: string;
  /** `<outDir>/<name>` */
  readonly dir: string;
  /** Value for `OPENCLAW_CONFIG_PATH`. */
  readonly configPath: string;
  /** Value for `OPENCLAW_STATE_DIR`. */
  readonly stateDir: string;
  readonly workspace: string;
  readonly port: number;
  /** Skills copied into `<workspace>/skills`. */
  readonly skills: readonly string[];
  readonly config: OpenClawConfig;
}

export interface ProfileSet {
  readonly web: OpenClawProfile;
  readonly knowledge: OpenClawProfile;
}

export const DEFAULT_PORTS = { knowledge: 19300, web: 19100 } as const;
export const DEFAULT_CONTEXT_WINDOW = 65_536;
/** OpenClaw keeps derived browser and CDP ports within base + 110. */
export const MIN_PORT_SPACING = 120;

/** Tools that change the gateway or start more agents; never for these agents. */
export const CONTROL_PLANE_TOOLS = [
  'gateway',
  'cron',
  'sessions_spawn',
  'sessions_send',
] as const;

/** The browser control is not used by either instance. */
const NO_BROWSER = ['browser'] as const;
const NO_BROWSER_CONTROL = { enabled: false, evaluateEnabled: false } as const;

/** Web research reads pages and its own skills, and nothing else. */
const WEB_DENY = [
  'write',
  'edit',
  'apply_patch',
  'browser',
  'group:runtime',
  'group:automation',
  'group:nodes',
  'group:sessions',
  'group:messaging',
  'group:ui',
  'group:media',
] as const;

/** The knowledge agent codes and runs scripts, but has no way onto the web. */
const KNOWLEDGE_DENY = [
  'group:web',
  'group:ui',
  'group:automation',
  'group:nodes',
  'group:messaging',
  'group:sessions',
  'group:media',
] as const;

/**
 * A path with forward slashes, the way the configs spell it. Only Windows
 * uses the backslash as a separator: on other systems it is an ordinary
 * character of a name and stays.
 */
export const posix = (
  path: string,
  windows: boolean = process.platform === 'win32',
): string => (windows ? path.replaceAll('\\', '/') : path);

/**
 * Whether `child` is `parent` or lies below it. Windows paths are compared
 * without regard to case, because that is how its file system sees them.
 */
export const isInside = (
  child: string,
  parent: string,
  caseInsensitive: boolean = process.platform === 'win32',
): boolean => {
  const c = caseInsensitive ? child.toLowerCase() : child;
  const p = caseInsensitive ? parent.toLowerCase() : parent;
  // A filesystem root already ends in a separator.
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
};

/** An absolute path with forward slashes, the way the configs spell it. */
export const absolute = (path: string): string => posix(resolve(path));

/** Whether two paths are the same place (case-blind on Windows). */
export const samePath = (a: string, b: string): boolean =>
  isInside(a, b) && isInside(b, a);

const shared = (
  input: ProfileInput,
  port: number,
  token: string,
  workspace: string,
) => {
  const contextWindow = input.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  return {
    gateway: {
      auth: { mode: 'token', token },
      bind: 'loopback',
      // Without a mode the gateway refuses to start ("existing config is
      // missing gateway.mode"), though `config validate` accepts the file.
      mode: 'local',
      port,
    },
    models: {
      providers: {
        ollama: {
          api: 'ollama',
          apiKey: 'ollama-local',
          baseUrl: input.ollamaUrl,
          models: [
            {
              contextTokens: contextWindow,
              contextWindow,
              id: input.model,
              maxTokens: 8192,
              name: input.model,
              // The native adapter asks Ollama for exactly this context: left
              // out, Ollama uses its own (small) default and the agent
              // prompt overflows it ("Context overflow: prompt too large").
              params: { num_ctx: contextWindow },
            },
          ],
        },
      },
    },
    agentDefaults: {
      model: { primary: `ollama/${input.model}` },
      workspace,
    },
  };
};

const profile = (
  input: ProfileInput,
  name: ProfileName,
  port: number,
): OpenClawProfile => {
  const dir = absolute(join(input.outDir, name));
  const workspace = `${dir}/workspace`;
  const base = shared(input, port, input.tokens[name], workspace);
  const projectRepo =
    input.projectRepo === undefined ? undefined : absolute(input.projectRepo);

  if (name === 'web') {
    return {
      agentId: 'research',
      config: {
        agents: {
          defaults: base.agentDefaults,
          entries: {
            research: {
              name: 'Web research',
              sandbox: { mode: 'off' },
              skills: ['web-research'],
              tools: {
                alsoAllow: ['read', 'group:web'],
                deny: [...WEB_DENY],
                profile: 'minimal',
              },
              workspace,
            },
          },
        },
        browser: NO_BROWSER_CONTROL,
        gateway: base.gateway,
        models: base.models,
        tools: {
          deny: [...CONTROL_PLANE_TOOLS, ...NO_BROWSER],
          // Exec outside the sandbox: never, for either instance.
          elevated: { enabled: false },
          fs: { workspaceOnly: true },
          sessions: { visibility: 'self' },
        },
      },
      configPath: `${dir}/openclaw.json`,
      dir,
      name,
      port,
      skills: ['web-research'],
      stateDir: `${dir}/state`,
      workspace,
    };
  }

  return {
    agentId: 'knowledge',
    config: {
      agents: {
        defaults: base.agentDefaults,
        entries: {
          knowledge: {
            name: 'Project knowledge',
            sandbox: { mode: 'off' },
            skills: ['knowledge-search'],
            tools: { deny: [...KNOWLEDGE_DENY], profile: 'coding' },
            workspace,
            ...(projectRepo === undefined ? {} : { cwd: projectRepo }),
          },
        },
      },
      browser: NO_BROWSER_CONTROL,
      gateway: base.gateway,
      models: base.models,
      tools: {
        // Denied for the whole instance, not only for its agent: nothing
        // here can turn the web back on.
        deny: [...CONTROL_PLANE_TOOLS, ...NO_BROWSER, 'group:web'],
        elevated: { enabled: false },
        sessions: { visibility: 'self' },
      },
    },
    configPath: `${dir}/openclaw.json`,
    dir,
    name,
    port,
    skills: ['knowledge-search'],
    stateDir: `${dir}/state`,
    workspace,
  };
};

/** Builds both profiles; throws when the input could not be isolated. */
export const buildProfiles = (input: ProfileInput): ProfileSet => {
  const ports = input.ports ?? DEFAULT_PORTS;
  const set: ProfileSet = {
    knowledge: profile(input, 'knowledge', ports.knowledge),
    web: profile(input, 'web', ports.web),
  };
  const problems = checkProfiles(set, input);
  if (problems.length > 0) {
    throw new Error(
      `The profiles are not isolated:\n- ${problems.join('\n- ')}`,
    );
  }
  return set;
};

const get = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) =>
      typeof current === 'object' && current !== null
        ? (current as Record<string, unknown>)[key]
        : undefined,
    value,
  );

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

const agentOf = (profile: OpenClawProfile): unknown =>
  get(profile.config, 'agents', 'entries', profile.agentId);

/**
 * The properties that make the two instances a trust boundary. Returns the
 * violations; an empty list means the set may be written.
 */
export const checkProfiles = (
  set: ProfileSet,
  input?: Pick<ProfileInput, 'dataDir' | 'projectRepo'>,
): string[] => {
  const problems: string[] = [];
  const { web, knowledge } = set;

  for (const key of ['configPath', 'stateDir', 'workspace', 'port'] as const) {
    if (web[key] === knowledge[key]) {
      problems.push(`both profiles share ${key} (${String(web[key])})`);
    }
  }
  for (const entry of [web, knowledge]) {
    if (
      !Number.isInteger(entry.port) ||
      entry.port < 1024 ||
      entry.port + MIN_PORT_SPACING > 65_535
    ) {
      problems.push(`${entry.name} port ${entry.port} is not usable`);
    }
  }
  if (Math.abs(web.port - knowledge.port) < MIN_PORT_SPACING) {
    problems.push(
      `ports ${web.port} and ${knowledge.port} are closer than ${MIN_PORT_SPACING}; derived browser ports would collide`,
    );
  }

  for (const entry of [web, knowledge]) {
    const deny = strings(get(entry.config, 'tools', 'deny'));
    for (const tool of CONTROL_PLANE_TOOLS) {
      if (!deny.includes(tool)) {
        problems.push(
          `${entry.name} does not deny the control-plane tool ${tool}`,
        );
      }
    }
    if (!deny.includes('browser')) {
      problems.push(`${entry.name} does not deny the browser tool`);
    }
    if (get(entry.config, 'browser', 'enabled') !== false) {
      problems.push(`${entry.name} leaves the browser control on`);
    }
    if (get(entry.config, 'tools', 'elevated', 'enabled') !== false) {
      problems.push(`${entry.name} allows elevated exec outside the sandbox`);
    }
    const models = get(entry.config, 'models', 'providers', 'ollama', 'models');
    const numCtx = get(
      Array.isArray(models) ? models[0] : undefined,
      'params',
      'num_ctx',
    );
    if (typeof numCtx !== 'number' || !Number.isInteger(numCtx) || numCtx < 1) {
      problems.push(
        `${entry.name} does not ask Ollama for a context size (params.num_ctx); Ollama's own default is too small for an agent`,
      );
    }
    if (get(entry.config, 'gateway', 'mode') !== 'local') {
      problems.push(`${entry.name} gateway does not run in local mode`);
    }
    if (get(entry.config, 'gateway', 'bind') !== 'loopback') {
      problems.push(`${entry.name} gateway is not bound to loopback`);
    }
    const token = get(entry.config, 'gateway', 'auth', 'token');
    if (
      get(entry.config, 'gateway', 'auth', 'mode') !== 'token' ||
      typeof token !== 'string' ||
      token.length < 16
    ) {
      problems.push(
        `${entry.name} gateway needs token auth with a token of at least 16 characters`,
      );
    }
    const baseUrl = get(
      entry.config,
      'models',
      'providers',
      'ollama',
      'baseUrl',
    );
    if (typeof baseUrl !== 'string' || /\/v1\/?$/.test(baseUrl)) {
      problems.push(
        `${entry.name} must use the native Ollama URL, not /v1 (it breaks tool calling)`,
      );
    }
    if (
      get(entry.config, 'agents', 'defaults', 'workspace') !== entry.workspace
    ) {
      problems.push(`${entry.name} default workspace differs from its own`);
    }
    if (
      get(entry.config, 'agents', 'entries', entry.agentId, 'workspace') !==
      entry.workspace
    ) {
      problems.push(
        `the ${entry.name} agent has a workspace that is not its own`,
      );
    }
  }
  if (web.config && knowledge.config) {
    const tokenWeb = get(web.config, 'gateway', 'auth', 'token');
    if (
      tokenWeb !== undefined &&
      tokenWeb === get(knowledge.config, 'gateway', 'auth', 'token')
    ) {
      problems.push('both gateways share one token');
    }
  }

  // The web instance must not be able to reach, or be told about, the cache.
  const webAgent = agentOf(web);
  const webSkills = strings(get(webAgent, 'skills'));
  if (webSkills.includes('knowledge-search')) {
    problems.push('the web profile has the knowledge-search skill');
  }
  if (webSkills.length !== 1 || webSkills[0] !== 'web-research') {
    problems.push('the web profile must have exactly the web-research skill');
  }
  if (get(web.config, 'tools', 'fs', 'workspaceOnly') !== true) {
    problems.push('the web profile may read outside its workspace');
  }
  const webDeny = strings(get(webAgent, 'tools', 'deny'));
  for (const tool of ['group:runtime', 'write', 'edit', 'apply_patch']) {
    if (!webDeny.includes(tool)) {
      problems.push(`the web profile does not deny ${tool}`);
    }
  }
  if (input !== undefined) {
    const dataDir = absolute(input.dataDir);
    for (const entry of [web, knowledge]) {
      if (isInside(entry.dir, dataDir)) {
        problems.push(
          `the ${entry.name} profile directory is inside the data directory; keep generated profiles outside the cache`,
        );
      }
    }
    if (isInside(dataDir, web.dir)) {
      problems.push('the data directory is inside the web profile directory');
    }
    // The knowledge agent has the coding tools and no sandbox: if the project
    // it works on contains a profile, it could edit that profile's config.
    // Both the wanted directory and the one that the knowledge agent entry
    // really holds are checked: a set that was changed afterwards counts.
    const stored = get(agentOf(knowledge), 'cwd');
    const repos = new Set(
      [input.projectRepo, stored]
        .filter((path): path is string => typeof path === 'string')
        .map((path) => absolute(path)),
    );
    for (const repo of repos) {
      for (const entry of [web, knowledge]) {
        if (isInside(entry.dir, repo) || isInside(repo, entry.dir)) {
          problems.push(
            `the ${entry.name} profile directory and the project repository overlap; generate the profiles outside the repository (--out)`,
          );
        }
      }
      if (isInside(repo, dataDir)) {
        problems.push(
          'the project directory of the knowledge agent is inside the data directory',
        );
      }
    }
  }

  // The knowledge instance reaches the Internet only through the relay.
  const knowledgeAgent = agentOf(knowledge);
  const knowledgeDeny = strings(get(knowledgeAgent, 'tools', 'deny'));
  if (!strings(get(knowledge.config, 'tools', 'deny')).includes('group:web')) {
    problems.push(
      'the knowledge instance does not deny the web tools as a whole',
    );
  }
  for (const tool of ['group:web']) {
    if (!knowledgeDeny.includes(tool)) {
      problems.push(`the knowledge profile does not deny ${tool}`);
    }
  }
  const knowledgeSkills = strings(get(knowledgeAgent, 'skills'));
  if (
    knowledgeSkills.length !== 1 ||
    knowledgeSkills[0] !== 'knowledge-search'
  ) {
    problems.push(
      'the knowledge profile must have exactly the knowledge-search skill',
    );
  }
  return problems;
};
