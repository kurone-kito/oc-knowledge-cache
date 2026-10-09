import type { OpenClawProfile, ProfileSet } from './profiles.mts';

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

/**
 * The lines that talk to one profile's gateway: its terminal UI, and one
 * question asked without it. The two variables are what select the instance;
 * the port and the token come from that profile's config.
 */
export const tuiCommands = (profile: OpenClawProfile): string[] => {
  const powerShell = `$env:OPENCLAW_CONFIG_PATH=${quotePowerShell(profile.configPath)}; $env:OPENCLAW_STATE_DIR=${quotePowerShell(profile.stateDir)};`;
  const posix = `OPENCLAW_CONFIG_PATH=${quotePosix(profile.configPath)} OPENCLAW_STATE_DIR=${quotePosix(profile.stateDir)}`;
  const ask = `openclaw agent --agent ${profile.agentId} --timeout 900 --message "..."`;
  return [
    `# ${profile.name}: terminal UI`,
    `PowerShell:  ${powerShell} openclaw tui`,
    `POSIX shell: ${posix} openclaw tui`,
    `# ${profile.name}: one question`,
    `PowerShell:  ${powerShell} ${ask}`,
    `POSIX shell: ${posix} ${ask}`,
  ];
};

/**
 * What a person needs after the profiles are generated: the lines that start
 * both gateways, then those that talk to them. `provision apply` and
 * `openclaw:generate` print the same lines under their own headings.
 */
export const afterGeneration = (
  set: ProfileSet,
  startHeading: string,
): string[] => [
  startHeading,
  ...startCommands(set.web),
  ...startCommands(set.knowledge),
  '',
  'Talk to an instance from another terminal (the two variables select it):',
  ...tuiCommands(set.web),
  ...tuiCommands(set.knowledge),
];
