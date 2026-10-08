import { randomBytes } from 'node:crypto';
import { realPathOf } from './paths.mts';
import {
  buildProfiles,
  type ProfileInput,
  type ProfileSet,
} from './profiles.mts';
import { readExistingTokens, writeProfiles } from './write.mts';

export type GenerateOptions = Omit<ProfileInput, 'tokens'>;

/** A fresh gateway secret. */
export const newToken = (): string => randomBytes(24).toString('base64url');

/**
 * Builds both profiles, keeping the gateway tokens of an earlier run so that
 * running gateways and their clients stay valid. Writes nothing.
 */
export const prepareProfiles = async (
  requested: GenerateOptions,
  makeToken: () => string = newToken,
): Promise<ProfileSet> => {
  const options = await resolveOptions(requested);
  const draft = buildProfiles({
    ...options,
    tokens: { knowledge: makeToken(), web: makeToken() },
  });
  const existing = await readExistingTokens(draft);
  return buildProfiles({
    ...options,
    tokens: {
      knowledge: existing.knowledge ?? makeToken(),
      web: existing.web ?? makeToken(),
    },
  });
};

/**
 * The folders at the places where files really end up (see realPathOf): the
 * isolation is judged on those, and so are the paths that end up in the
 * configs and the skill. The project repository counts too, because its
 * coding tools could otherwise reach a profile through a link.
 */
export const resolveOptions = async (
  requested: GenerateOptions,
): Promise<GenerateOptions> => ({
  ...requested,
  dataDir: await realPathOf(requested.dataDir),
  outDir: await realPathOf(requested.outDir),
  ...(requested.projectRepo === undefined
    ? {}
    : { projectRepo: await realPathOf(requested.projectRepo) }),
});

/**
 * Why the folders that were asked for cannot hold isolated profiles (the same
 * rules a generation applies), or undefined when they can. Nothing is read
 * or written; the folders should be resolved already.
 */
export const layoutProblem = (options: GenerateOptions): string | undefined => {
  try {
    buildProfiles({
      ...options,
      tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/** Prepares and writes both profiles; returns them with the files written. */
export const generateProfiles = async (
  options: GenerateOptions,
  makeToken: () => string = newToken,
): Promise<{ set: ProfileSet; written: string[] }> => {
  const resolved = await resolveOptions(options);
  const set = await prepareProfiles(resolved, makeToken);
  const written = await writeProfiles(set, {
    dataDir: resolved.dataDir,
    repoRoot: resolved.repoRoot,
  });
  return { set, written };
};
