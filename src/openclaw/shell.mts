import type { OpenClawProfile } from './profiles.mts';

/** A value as one literal word for a POSIX shell: `it's` becomes `'it'\''s'`. */
export const quotePosix = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

/** A value as a literal PowerShell string: `it's` becomes `'it''s'`. */
export const quotePowerShell = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

/** The lines that start one profile's gateway, for PowerShell and POSIX shells. */
export const startCommands = (profile: OpenClawProfile): string[] => [
  `# ${profile.name}`,
  `PowerShell:  $env:OPENCLAW_CONFIG_PATH=${quotePowerShell(profile.configPath)}; $env:OPENCLAW_STATE_DIR=${quotePowerShell(profile.stateDir)}; openclaw gateway --port ${profile.port}`,
  `POSIX shell: OPENCLAW_CONFIG_PATH=${quotePosix(profile.configPath)} OPENCLAW_STATE_DIR=${quotePosix(profile.stateDir)} openclaw gateway --port ${profile.port}`,
];
