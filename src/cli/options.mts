export interface NumberRules {
  /** Smallest accepted value (default 0). */
  readonly min?: number;
  /** Largest accepted value (default: no limit). */
  readonly max?: number;
  /** Reject fractions such as 1.5 (for counts). */
  readonly integer?: boolean;
}

/** Parses an optional numeric CLI option; throws a readable error if invalid. */
export const optionalNumber = (
  name: string,
  raw: string | undefined,
  {
    min = 0,
    max = Number.POSITIVE_INFINITY,
    integer = false,
  }: NumberRules = {},
): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (
    raw.trim() === '' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    const kind = integer ? 'an integer' : 'a number';
    const range =
      max === Number.POSITIVE_INFINITY ? `>= ${min}` : `from ${min} to ${max}`;
    throw new Error(`--${name} must be ${kind} ${range}, got "${raw}"`);
  }
  return value;
};

/**
 * Arguments for `parseArgs`. pnpm forwards the `--` separator of
 * `pnpm run <script> -- <args>` to the script, so drop a leading one.
 */
export const scriptArgs = (argv: readonly string[]): string[] =>
  argv[0] === '--' ? argv.slice(1) : [...argv];

/**
 * The text to search for: the words after the options, or, when
 * `envName` is given, the value of that environment variable. Passing the
 * question through the environment keeps it out of any shell command line,
 * so quotes and `$(...)` in it cannot do anything.
 */
export const resolveQuestion = (
  positionals: readonly string[],
  envName: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  if (envName === undefined) {
    return positionals.join(' ').trim();
  }
  if (positionals.length > 0) {
    throw new Error(
      `Give the question either as words or in $${envName}, not both`,
    );
  }
  return (env[envName] ?? '').trim();
};

/** The data directory: the option, else `$KC_DATA_DIR`, else `.data`. */
export const resolveDataDir = (
  option: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => option ?? env['KC_DATA_DIR'] ?? '.data';
