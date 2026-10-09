import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { scanChanges } from '../nas/changes.mts';
import { loadManifest } from '../nas/manifest.mts';
import { DEFAULT_EXTENSIONS } from '../nas/scan.mts';
import { resolveDataDir, scriptArgs } from './options.mts';

const USAGE = `Usage: pnpm run nas:scan --source <dir> [options]

Reports what the next ingestion would do: the changes under the source
directory compared with the manifest that ingest wrote the last time it
ran. This is a read-only dry run; neither the source nor the manifest is
written (only ingest updates the manifest, so before the first ingestion
everything is reported as added).

Options:
  --source <dir>   directory to scan, e.g. a mounted NAS share (required)
  --data <dir>     data directory holding manifest.json
                   (default $KC_DATA_DIR, else .data)
  --ext <list>     comma-separated extensions (default ${DEFAULT_EXTENSIONS.join(',')})
  --exclude <glob> skip paths matching the glob; repeatable
  --allow-empty    accept an empty scan even though files were known before
  --json           print the result as JSON
  -h, --help       show this help
`;

const LIST_LIMIT = 10;

const section = (title: string, paths: readonly string[]): string[] =>
  paths.length === 0
    ? []
    : [
        `${title} (${paths.length})`,
        ...paths.slice(0, LIST_LIMIT).map((path) => `  ${path}`),
        ...(paths.length > LIST_LIMIT
          ? [`  ... and ${paths.length - LIST_LIMIT} more`]
          : []),
      ];

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    args: scriptArgs(process.argv.slice(2)),
    options: {
      'allow-empty': { type: 'boolean' },
      data: { type: 'string' },
      exclude: { multiple: true, type: 'string' },
      ext: { type: 'string' },
      help: { short: 'h', type: 'boolean' },
      json: { type: 'boolean' },
      source: { type: 'string' },
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

  const manifestFile = join(resolveDataDir(values.data), 'manifest.json');
  const previous = await loadManifest(manifestFile);
  const extensions = values.ext
    ?.split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '')
    .map((e) => (e.startsWith('.') ? e : `.${e}`));
  const { diff, errors } = await scanChanges(values.source, previous, {
    allowEmpty: values['allow-empty'] === true,
    ...(extensions === undefined ? {} : { extensions }),
    ...(values.exclude === undefined ? {} : { exclude: values.exclude }),
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ diff, errors }, null, 2)}\n`);
  } else {
    const lines = [
      `Source: ${values.source}`,
      `Manifest: ${manifestFile} (${Object.keys(previous.entries).length} known files)`,
      `added ${diff.added.length}, changed ${diff.changed.length}, removed ${diff.removed.length}, unchanged ${diff.unchanged.length}`,
      '',
      ...section('Added', diff.added),
      ...section('Changed', diff.changed),
      ...section('Removed', diff.removed),
      ...section(
        'Could not be read (previous state kept)',
        errors.map((e) => `${e.path}: ${e.message}`),
      ),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return errors.length > 0 ? 2 : 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `nas:scan failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
