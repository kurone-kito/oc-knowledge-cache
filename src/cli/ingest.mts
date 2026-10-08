import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chooseEmbeddingModel } from '../ingest/embedding-model.mts';
import {
  type FileOutcome,
  type IngestReport,
  ingest,
} from '../ingest/ingest.mts';
import { detectHardware } from '../models/hardware.mts';
import {
  listInstalledModels,
  resolveOllamaBaseUrl,
} from '../models/ollama.mts';
import { DEFAULT_EXTENSIONS } from '../nas/scan.mts';
import { limitsForContext } from '../rag/chunk.mts';
import { createOllamaEmbedder } from '../rag/embed.mts';
import { openStore } from '../rag/store.mts';
import { optionalNumber, resolveDataDir, scriptArgs } from './options.mts';

const USAGE = `Usage: pnpm run ingest --source <dir> [options]

Brings the knowledge cache in line with the source directory: new and
changed files are converted, chunked, embedded with Ollama and stored;
files that disappeared are removed. The source is only read. Run it again
at any time; unchanged files cost nothing.

Options:
  --source <dir>       directory to ingest, e.g. a mounted NAS share (required)
  --data <dir>         data directory for manifest.json and store.sqlite
                       (default $KC_DATA_DIR, else .data)
  --dry-run            only report what would be done; needs no Ollama
  --embed-model <tag>  embedding model (default: the store's model, else the
                       best installed one; env KC_EMBED_MODEL)
  --ollama-url <url>   Ollama server (default: $OLLAMA_HOST or 127.0.0.1:11434)
  --ram-gib <n>        memory of the machine that runs Ollama, when it is not
                       this one (used to pick the embedding model)
  --vram-gib <n>       GPU memory of that machine (0 = no GPU)
  --unified-memory     GPU and CPU of that machine share one memory pool
  --ext <list>         comma-separated extensions (default ${DEFAULT_EXTENSIONS.join(',')})
  --exclude <glob>     skip paths matching the glob; repeatable
  --include-hidden     also read hidden sheets, rows and columns
  --max-chars <n>      chunk size in characters (default: from the model's context)
  --allow-empty        accept an empty source although files were known before
  --json               print the final report as JSON
  -h, --help           show this help

Exit status: 0 on success, 2 when some files failed or the run stopped early,
1 when the run could not start.
`;

const describeOutcome = (outcome: FileOutcome): string => {
  const detail =
    outcome.status === 'ok' && outcome.chunks !== undefined
      ? `${outcome.chunks} chunks`
      : (outcome.message ?? '');
  return `${outcome.action.padEnd(7)} ${outcome.status.padEnd(13)} ${outcome.path}${detail === '' ? '' : `  (${detail})`}`;
};

const summarize = (report: IngestReport): string => {
  const count = (status: FileOutcome['status']): number =>
    report.outcomes.filter((o) => o.status === status).length;
  const parts = report.dryRun
    ? [`${report.outcomes.length} to do`]
    : [
        `${count('ok')} done`,
        `${count('skipped')} skipped`,
        `${report.failed} failed`,
        `${count('not-attempted')} not attempted`,
      ];
  const lines = [
    ...(report.reprocessAll
      ? [
          'The conversion settings changed since the cache was built, so every file is processed again.',
        ]
      : []),
    `${parts.join(', ')}; ${report.unchanged} unchanged.`,
    ...report.unreadable.map(
      (e) => `could not read ${e.path}: ${e.message} (kept as it was)`,
    ),
    ...(report.aborted === undefined
      ? []
      : [`stopped early: ${report.aborted}`]),
    ...(report.stats === undefined
      ? []
      : [
          `store: ${report.stats.documents} documents, ${report.stats.chunks} chunks (${report.stats.model ?? 'no model'})`,
        ]),
  ];
  return `${lines.join('\n')}\n`;
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    args: scriptArgs(process.argv.slice(2)),
    options: {
      'allow-empty': { type: 'boolean' },
      data: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'embed-model': { type: 'string' },
      exclude: { multiple: true, type: 'string' },
      ext: { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      'include-hidden': { type: 'boolean' },
      json: { type: 'boolean' },
      'max-chars': { type: 'string' },
      'ollama-url': { type: 'string' },
      'ram-gib': { type: 'string' },
      source: { type: 'string' },
      'unified-memory': { type: 'boolean' },
      'vram-gib': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.source === undefined) {
    process.stderr.write(`--source is required\n\n${USAGE}`);
    return 1;
  }

  // The same choice as kc:search: the option, else $KC_DATA_DIR, else .data.
  const dataDir = resolveDataDir(values.data);
  const dryRun = values['dry-run'] === true;
  const extensions = values.ext
    ?.split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '')
    .map((e) => (e.startsWith('.') ? e : `.${e}`));
  const maxChars = optionalNumber('max-chars', values['max-chars'], {
    integer: true,
    min: 100,
  });
  const baseUrl = resolveOllamaBaseUrl(
    values['ollama-url'] ?? process.env['OLLAMA_HOST'],
  );

  let embedder: ReturnType<typeof createOllamaEmbedder> | undefined;
  let chunk = maxChars === undefined ? undefined : { maxChars };
  if (!dryRun) {
    const storeFile = join(dataDir, 'store.sqlite');
    let storedModel: string | undefined;
    if (existsSync(storeFile)) {
      const store = openStore(storeFile, { readOnly: true });
      storedModel = store.model;
      store.close();
    }
    const [installed, hardware] = await Promise.all([
      listInstalledModels({ baseUrl, signal: AbortSignal.timeout(30_000) }),
      // For a remote Ollama these describe the machine that runs it.
      detectHardware(undefined, {
        ramGiB: optionalNumber('ram-gib', values['ram-gib'], { min: 1 }),
        unifiedMemory: values['unified-memory'],
        vramGiB: optionalNumber('vram-gib', values['vram-gib']),
      }),
    ]);
    const choice = chooseEmbeddingModel({
      hardware,
      installed,
      requested: values['embed-model'] ?? process.env['KC_EMBED_MODEL'],
      storedModel,
    });
    process.stderr.write(
      `Embedding model: ${choice.model} (${choice.origin}${choice.contextLength === undefined ? '' : `, context ${choice.contextLength}`})\n`,
    );
    embedder = createOllamaEmbedder({ baseUrl, model: choice.model });
    chunk = { ...limitsForContext(choice.contextLength), ...chunk };
  }

  const report = await ingest(
    {
      dataDir,
      dryRun,
      includeHidden: values['include-hidden'] === true,
      onProgress: (outcome, { index, total }) => {
        if (!values.json) {
          process.stdout.write(
            `[${index}/${total}] ${describeOutcome(outcome)}\n`,
          );
        }
      },
      source: values.source,
      ...(values['allow-empty'] === true ? { allowEmpty: true } : {}),
      ...(chunk === undefined ? {} : { chunk }),
      ...(values.exclude === undefined ? {} : { exclude: values.exclude }),
      ...(extensions === undefined ? {} : { extensions }),
    },
    embedder,
  );

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (dryRun) {
      for (const [index, outcome] of report.outcomes.entries()) {
        process.stdout.write(
          `[${index + 1}/${report.outcomes.length}] ${describeOutcome(outcome)}\n`,
        );
      }
    }
    process.stdout.write(summarize(report));
  }
  // Anything that was not fully processed is not a plain success.
  return report.failed > 0 ||
    report.aborted !== undefined ||
    report.unreadable.length > 0
    ? 2
    : 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `ingest failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
