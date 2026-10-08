export interface NumberRules {
  /** Smallest accepted value (default 0). */
  readonly min?: number;
  /** Reject fractions such as 1.5 (for counts). */
  readonly integer?: boolean;
}

/** Parses an optional numeric CLI option; throws a readable error if invalid. */
export const optionalNumber = (
  name: string,
  raw: string | undefined,
  { min = 0, integer = false }: NumberRules = {},
): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (
    raw.trim() === '' ||
    !Number.isFinite(value) ||
    value < min ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `--${name} must be ${integer ? 'an integer' : 'a number'} >= ${min}, got "${raw}"`,
    );
  }
  return value;
};

/**
 * Arguments for `parseArgs`. pnpm forwards the `--` separator of
 * `pnpm run <script> -- <args>` to the script, so drop a leading one.
 */
export const scriptArgs = (argv: readonly string[]): string[] =>
  argv[0] === '--' ? argv.slice(1) : [...argv];
