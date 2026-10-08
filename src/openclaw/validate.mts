import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OpenClawProfile } from './profiles.mts';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export interface ValidationResult {
  readonly valid: boolean;
  /** The CLI's own explanation: issues, or why it could not run. */
  readonly detail: string;
}

/** Runs a command with extra environment; resolves with stdout. */
export type RunWithEnv = (
  command: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<string>;

/**
 * How to start a command. On Windows an npm-installed tool is a `.cmd` shim,
 * which Node refuses to start without a shell (`spawn EINVAL`, or ENOENT for
 * the bare name), so anything but a real `.exe` goes through the shell. The
 * arguments passed here are fixed words, and a file name with anything beyond
 * plain path characters (a space, `&`, `(`, ...) is quoted, so that the shell
 * reads it as one word.
 */
export const spawnPlan = (
  file: string,
  platform: string = process.platform,
): { readonly file: string; readonly shell: boolean } => {
  const viaShell = platform === 'win32' && !/\.exe$/i.test(file);
  // cmd.exe expands %NAME% even inside double quotes and offers no escape on a
  // command line, so such a path cannot be passed on faithfully.
  if (viaShell && file.includes('%')) {
    throw new Error(
      `${file} contains "%", which cmd.exe would expand; put the command in a path without it`,
    );
  }
  return {
    file: viaShell && /[^\w.:/\\-]/.test(file) ? `"${file}"` : file,
    shell: viaShell,
  };
};

export const runWithEnv: RunWithEnv = async ([command, ...args], env) => {
  const { file, shell } = spawnPlan(command as string);
  const options = {
    env: { ...process.env, ...env },
    timeout: 120_000,
    windowsHide: true,
  };
  // One command line for the shell: handing it an argument list is deprecated
  // (the shell would only join the words, unescaped).
  return (
    shell
      ? await execAsync([file, ...args].join(' '), options)
      : await execFileAsync(file, args, options)
  ).stdout;
};

/** The environment that points OpenClaw at one profile. */
export const profileEnv = (
  profile: OpenClawProfile,
): Record<string, string> => ({
  OPENCLAW_CONFIG_PATH: profile.configPath,
  OPENCLAW_STATE_DIR: profile.stateDir,
});

/**
 * Asks the OpenClaw CLI to validate a profile's config
 * (`openclaw config validate --json`) without starting a gateway.
 * `cli` is the command to run, e.g. `['openclaw']` or `[node, 'openclaw.mjs']`.
 */
export const validateWithOpenClaw = async (
  profile: OpenClawProfile,
  cli: readonly string[],
  run: RunWithEnv = runWithEnv,
): Promise<ValidationResult> => {
  let stdout: string;
  try {
    stdout = await run(
      [...cli, 'config', 'validate', '--json'],
      profileEnv(profile),
    );
  } catch (error) {
    // `config validate` exits non-zero for an invalid config but still prints JSON.
    const output = (error as { stdout?: unknown }).stdout;
    if (typeof output !== 'string' || output.trim() === '') {
      return {
        detail: `Could not run ${cli.join(' ')}: ${error instanceof Error ? error.message : String(error)}`,
        valid: false,
      };
    }
    stdout = output;
  }
  try {
    const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
      valid?: unknown;
      issues?: { path?: string; message?: string }[];
    };
    const issues = (parsed.issues ?? [])
      .map((issue) => `${issue.path ?? '?'}: ${issue.message ?? '?'}`)
      .join('; ');
    return { detail: issues, valid: parsed.valid === true };
  } catch {
    return {
      detail: `Unexpected output: ${stdout.slice(0, 200)}`,
      valid: false,
    };
  }
};

/**
 * The command that runs the OpenClaw CLI: `$KC_OPENCLAW_CLI` when set (an
 * executable, or an `openclaw.mjs` that is run with the current Node.js),
 * otherwise `openclaw` from the PATH.
 */
export const resolveOpenClawCommand = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] => {
  const configured = env['KC_OPENCLAW_CLI']?.trim();
  if (configured === undefined || configured === '') {
    return ['openclaw'];
  }
  return configured.toLowerCase().endsWith('.mjs')
    ? [process.execPath, configured]
    : [configured];
};
