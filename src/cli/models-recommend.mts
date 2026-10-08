import { parseArgs } from 'node:util';
import { formatRecommendation } from '../models/format.mts';
import { detectHardware } from '../models/hardware.mts';
import {
  listInstalledModels,
  resolveOllamaBaseUrl,
} from '../models/ollama.mts';
import { recommendModels } from '../models/recommend.mts';
import { optionalNumber, scriptArgs } from './options.mts';

const USAGE = `Usage: pnpm run models:recommend [-- options]

Recommends installed Ollama models for this machine.

Options:
  --json               print the full result as JSON
  --ollama-url <url>   Ollama server (default: $OLLAMA_HOST or 127.0.0.1:11434)
  --ram-gib <n>        override the detected system RAM
  --vram-gib <n>       override the detected GPU memory (0 = no GPU)
  --unified-memory     GPU and CPU share one memory pool (--no-unified-memory: separate)
  --min-context <n>    smallest context window for the agent role (default 65536)
  --top <n>            candidates to list per role (default 5)
  -h, --help           show this help
`;

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    allowNegative: true,
    args: scriptArgs(process.argv.slice(2)),
    options: {
      help: { short: 'h', type: 'boolean' },
      json: { type: 'boolean' },
      'min-context': { type: 'string' },
      'ollama-url': { type: 'string' },
      'ram-gib': { type: 'string' },
      top: { type: 'string' },
      'unified-memory': { type: 'boolean' },
      'vram-gib': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const minContext = optionalNumber('min-context', values['min-context'], {
    integer: true,
    min: 1,
  });
  const top = optionalNumber('top', values.top, { integer: true, min: 1 }) ?? 5;
  const hardware = await detectHardware(undefined, {
    ramGiB: optionalNumber('ram-gib', values['ram-gib'], { min: 1 }),
    unifiedMemory: values['unified-memory'],
    vramGiB: optionalNumber('vram-gib', values['vram-gib']),
  });
  const baseUrl = resolveOllamaBaseUrl(
    values['ollama-url'] ?? process.env['OLLAMA_HOST'],
  );
  const installed = await listInstalledModels({
    baseUrl,
    signal: AbortSignal.timeout(30_000),
  });
  const recommendation = recommendModels(
    hardware,
    installed,
    minContext === undefined ? {} : { minAgentContext: minContext },
  );

  process.stdout.write(
    values.json
      ? `${JSON.stringify(recommendation, null, 2)}\n`
      : formatRecommendation(recommendation, top),
  );
};

main().catch((error: unknown) => {
  process.stderr.write(
    `models:recommend failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
