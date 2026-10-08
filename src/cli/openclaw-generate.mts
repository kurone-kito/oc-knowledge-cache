import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { detectHardware } from '../models/hardware.mts';
import {
  listInstalledModels,
  resolveOllamaBaseUrl,
} from '../models/ollama.mts';
import { recommendModels } from '../models/recommend.mts';
import { realPathOf } from '../openclaw/paths.mts';
import {
  buildProfiles,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_PORTS,
  type ProfileSet,
} from '../openclaw/profiles.mts';
import { startCommands } from '../openclaw/shell.mts';
import {
  resolveOpenClawCommand,
  validateWithOpenClaw,
} from '../openclaw/validate.mts';
import { readExistingTokens, writeProfiles } from '../openclaw/write.mts';
import { optionalNumber, scriptArgs } from './options.mts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const USAGE = `Usage: pnpm run openclaw:generate [options]

Generates the two isolated OpenClaw profiles of this system:

  web        researches on the Internet; cannot see the NAS, the data
             directory or the knowledge cache
  knowledge  answers from the cache and works on the project repository;
             has no web tools

Options:
  --out <dir>             where to write the profiles (default .openclaw)
  --data <dir>            data directory with the cache (default .data)
  --project-repo <dir>    repository the knowledge agent works on
  --ram-gib <n>           memory of the machine that runs Ollama, when it is not
                          this one (used to pick the model)
  --vram-gib <n>          GPU memory of that machine (0 = no GPU)
  --unified-memory        GPU and CPU of that machine share one memory pool
  --model <tag>           Ollama model for both agents (default: the best
                          installed one, see models:recommend)
  --context-window <n>    model context window in tokens (default ${DEFAULT_CONTEXT_WINDOW})
  --ollama-url <url>      Ollama server (default: $OLLAMA_HOST or 127.0.0.1:11434)
  --web-port <n>          gateway port of the web profile (default ${DEFAULT_PORTS.web})
  --knowledge-port <n>    gateway port of the knowledge profile (default ${DEFAULT_PORTS.knowledge})
  --validate              check the configs with "openclaw config validate"
                          (the openclaw on PATH, or the command in $KC_OPENCLAW_CLI)
  --dry-run               print what would be written, without writing
  -h, --help              show this help
`;

const newToken = (): string => randomBytes(24).toString('base64url');

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    args: scriptArgs(process.argv.slice(2)),
    options: {
      'context-window': { type: 'string' },
      data: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { short: 'h', type: 'boolean' },
      'knowledge-port': { type: 'string' },
      model: { type: 'string' },
      'ollama-url': { type: 'string' },
      out: { type: 'string' },
      'project-repo': { type: 'string' },
      'ram-gib': { type: 'string' },
      'unified-memory': { type: 'boolean' },
      validate: { type: 'boolean' },
      'vram-gib': { type: 'string' },
      'web-port': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const ollamaUrl = resolveOllamaBaseUrl(
    values['ollama-url'] ?? process.env['OLLAMA_HOST'],
  );
  let model = values.model;
  let contextWindow = optionalNumber(
    'context-window',
    values['context-window'],
    {
      integer: true,
      min: 1024,
    },
  );
  if (model === undefined) {
    const [installed, hardware] = await Promise.all([
      listInstalledModels({
        baseUrl: ollamaUrl,
        signal: AbortSignal.timeout(30_000),
      }),
      // For a remote Ollama these describe the machine that runs it.
      detectHardware(undefined, {
        ramGiB: optionalNumber('ram-gib', values['ram-gib'], { min: 1 }),
        unifiedMemory: values['unified-memory'],
        vramGiB: optionalNumber('vram-gib', values['vram-gib']),
      }),
    ]);
    const best = recommendModels(hardware, installed).agent.best?.model;
    if (best === undefined) {
      process.stderr.write(
        'No installed model can act as an agent; run "pnpm run models:recommend" or pass --model\n',
      );
      return 1;
    }
    model = best.name;
    contextWindow ??=
      best.contextLength === undefined
        ? undefined
        : Math.min(best.contextLength, DEFAULT_CONTEXT_WINDOW);
    process.stderr.write(`Agent model: ${model}\n`);
  }

  // Where the files really end up, so a link cannot hide an overlap.
  const outDir = await realPathOf(values.out ?? '.openclaw');
  const dataDir = await realPathOf(values.data ?? '.data');
  const projectRepo =
    values['project-repo'] === undefined
      ? undefined
      : await realPathOf(values['project-repo']);
  const webPort = optionalNumber('web-port', values['web-port'], {
    integer: true,
    min: 1024,
  });
  const knowledgePort = optionalNumber(
    'knowledge-port',
    values['knowledge-port'],
    {
      integer: true,
      min: 1024,
    },
  );
  const base = {
    dataDir,
    model,
    ollamaUrl,
    outDir,
    ports: {
      knowledge: knowledgePort ?? DEFAULT_PORTS.knowledge,
      web: webPort ?? DEFAULT_PORTS.web,
    },
    projectRepo,
    repoRoot: REPO_ROOT,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };

  // Keep the tokens of an earlier run so running gateways and clients stay valid.
  const draft = buildProfiles({
    ...base,
    tokens: { knowledge: newToken(), web: newToken() },
  });
  const existing = await readExistingTokens(draft);
  const set: ProfileSet = buildProfiles({
    ...base,
    tokens: {
      knowledge: existing.knowledge ?? newToken(),
      web: existing.web ?? newToken(),
    },
  });

  if (values['dry-run']) {
    process.stdout.write(
      `${JSON.stringify(
        JSON.parse(JSON.stringify(set), (key, value) =>
          key === 'token' ? '<hidden>' : value,
        ),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const written = await writeProfiles(set, { dataDir, repoRoot: REPO_ROOT });
  process.stdout.write(
    [
      `Wrote ${written.length} files under ${outDir}`,
      '',
      'Start the two gateways in separate terminals:',
      ...startCommands(set.web),
      ...startCommands(set.knowledge),
      '',
      'The knowledge profile can read the cache in:',
      `  ${dataDir}`,
      'Only the host-side "pnpm run ingest" should write it: make it read-only for',
      'the OS user that runs the gateways (the tool policy cannot enforce that).',
      '',
    ].join('\n'),
  );

  if (values.validate) {
    const cli = resolveOpenClawCommand();
    let failed = false;
    for (const profile of [set.web, set.knowledge]) {
      const result = await validateWithOpenClaw(profile, cli);
      process.stdout.write(
        `${profile.name}: ${result.valid ? 'valid' : `INVALID ${result.detail}`}\n`,
      );
      failed ||= !result.valid;
    }
    return failed ? 2 : 0;
  }
  return 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `openclaw:generate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
