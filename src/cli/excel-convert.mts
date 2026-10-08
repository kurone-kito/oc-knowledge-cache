import { parseArgs } from 'node:util';
import { convertWorkbookFile } from '../excel/convert.mts';
import { scriptArgs } from './options.mts';

const USAGE = `Usage: pnpm run excel:convert <file.xlsx> [options]

Converts a workbook into the Markdown (default) or JSON model that the
ingestion pipeline stores. Use it to check how a design document is read.

Options:
  --json             print the JSON model instead of Markdown
  --include-hidden   include hidden sheets, rows and columns
  -h, --help         show this help
`;

const main = async (): Promise<number> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: scriptArgs(process.argv.slice(2)),
    options: {
      help: { short: 'h', type: 'boolean' },
      'include-hidden': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [file] = positionals;
  if (file === undefined || positionals.length > 1) {
    process.stderr.write(`Exactly one workbook file is required\n\n${USAGE}`);
    return 1;
  }

  const result = await convertWorkbookFile(file, {
    includeHidden: values['include-hidden'] === true,
  });
  if (!result.ok) {
    process.stderr.write(
      `excel:convert failed (${result.error.code}): ${result.error.message}\n`,
    );
    return 1;
  }
  process.stdout.write(
    values.json
      ? `${JSON.stringify(result.value.workbook, null, 2)}\n`
      : result.value.markdown,
  );
  return 0;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `excel:convert failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
