import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveOllamaBaseUrl } from '../models/ollama.mts';
import { createOllamaEmbedder } from '../rag/embed.mts';
import { formatHits, searchKnowledge } from '../rag/search.mts';
import { openStore } from '../rag/store.mts';
import {
  optionalNumber,
  resolveDataDir,
  resolveQuestion,
  scriptArgs,
} from './options.mts';

const USAGE = `Usage: pnpm run kc:search "<question>" [options]

Searches the knowledge cache built by the ingest command and prints the
closest passages with their sources.

Options:
  --k <n>              number of results (default 5)
  --path <prefix>      only documents whose path starts with the prefix
  --sheet <name>       only chunks of this sheet
  --min-score <x>      drop results below this cosine similarity (0 to 1)
  --data <dir>         data directory holding store.sqlite (default: $KC_DATA_DIR, else .data)
  --question-env <VAR> read the question from this environment variable instead of
                       the command line (keeps it out of any shell)
  --ollama-url <url>   Ollama server (default: $OLLAMA_HOST or 127.0.0.1:11434)
  --json               print the hits as JSON
  -h, --help           show this help
`;

const main = async (): Promise<number> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: scriptArgs(process.argv.slice(2)),
    options: {
      data: { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      json: { type: 'boolean' },
      k: { type: 'string' },
      'min-score': { type: 'string' },
      'ollama-url': { type: 'string' },
      path: { type: 'string' },
      'question-env': { type: 'string' },
      sheet: { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const question = resolveQuestion(positionals, values['question-env']);
  if (question === '') {
    process.stderr.write(`A question is required\n\n${USAGE}`);
    return 1;
  }

  const file = join(resolveDataDir(values.data), 'store.sqlite');
  let store: ReturnType<typeof openStore>;
  try {
    store = openStore(file, { readOnly: true });
  } catch (error) {
    process.stderr.write(
      `No knowledge cache at ${file} (run the ingest command first): ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  try {
    const model = store.model;
    if (model === undefined) {
      process.stderr.write(
        `${file} holds no documents yet; run the ingest command first\n`,
      );
      return 1;
    }
    const embedder = createOllamaEmbedder({
      baseUrl: resolveOllamaBaseUrl(
        values['ollama-url'] ?? process.env['OLLAMA_HOST'],
      ),
      model,
    });
    const minScore = optionalNumber('min-score', values['min-score'], {
      max: 1,
    });
    const hits = await searchKnowledge(store, embedder, question, {
      k: optionalNumber('k', values.k, { integer: true, min: 1 }) ?? 5,
      ...(values.path === undefined ? {} : { pathPrefix: values.path }),
      ...(values.sheet === undefined ? {} : { sheet: values.sheet }),
      ...(minScore === undefined ? {} : { minScore }),
    });
    process.stdout.write(
      values.json ? `${JSON.stringify(hits, null, 2)}\n` : formatHits(hits),
    );
    return 0;
  } finally {
    store.close();
  }
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `kc:search failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
