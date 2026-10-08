import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type OpenClawProfile, type ProfileSet, posix } from './profiles.mts';

export interface WriteOptions {
  /** This repository; its `openclaw/skills` folder holds the skill sources. */
  readonly repoRoot: string;
  /** Data directory that the knowledge skill tells the agent to search. */
  readonly dataDir: string;
}

/** Where the skill sources live, relative to the repository root. */
const skillsSource = (repoRoot: string): string =>
  join(repoRoot, 'openclaw', 'skills');

/**
 * The names in a folder. With `all`, links and plain files count as well: a
 * stale one must be found and removed, not skipped.
 */
const namesIn = async (directory: string, all = false): Promise<string[]> => {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => all || entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

/** The inside of a JSON string for a value (without the quotes). */
export const jsonText = (value: string): string =>
  // A backtick is escaped too: the block sits in a Markdown fence, and a run of
  // backticks in a path must not be able to close it.
  JSON.stringify(value)
    .slice(1, -1)
    .replaceAll('`', `${String.fromCharCode(92)}u0060`);

/** Whether a name is in a list; Windows names are the same in any case. */
export const hasName = (names: readonly string[], name: string): boolean =>
  names.some((other) =>
    process.platform === 'win32'
      ? other.toLowerCase() === name.toLowerCase()
      : other === name,
  );

/**
 * Fills the placeholders of a skill file. The Ollama server is the one the
 * profile itself uses, so the search embeds its question with the same model
 * host as the agents.
 */
export const renderSkillFile = (
  text: string,
  options: WriteOptions,
  ollamaUrl: string,
): string =>
  // One pass with a callback: a value that contains "$&", "$$" or even a
  // placeholder of its own is inserted as it is and never scanned again. The
  // data directory and the server go into a JSON string of the skill, so they
  // are escaped for it.
  text.replace(/\{\{KC_(REPO|DATA|OLLAMA)\}\}/g, (_match, name: string) => {
    switch (name) {
      case 'REPO':
        return jsonText(posix(options.repoRoot));
      case 'DATA':
        return jsonText(posix(options.dataDir));
      default:
        return jsonText(ollamaUrl);
    }
  });

/**
 * What is wrong with writing at `path`: a link in its place would carry the
 * write somewhere else (for example into the cache), and so would a file that
 * also has another name (a hard link). Undefined when the path is plain or
 * does not exist.
 */
const linkProblem = async (path: string): Promise<string | undefined> => {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    // Nothing there, or a file where a parent folder should be: no link.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return undefined;
    }
    throw error;
  });
  if (info?.isSymbolicLink()) {
    return `${path} is a link; refusing to write generated files through it. Remove the link or choose another output folder.`;
  }
  if (info?.isFile() && info.nlink > 1) {
    return `${path} has more than one name (a hard link); refusing to write generated files through it. Remove the other name or the file.`;
  }
  // A pipe, a socket or a device would block or send the content elsewhere.
  if (info !== undefined && !info.isFile() && !info.isDirectory()) {
    return `${path} is not a regular file or folder; refusing to write generated files to it. Remove it.`;
  }
  return undefined;
};

const refuseLink = async (path: string): Promise<void> => {
  const problem = await linkProblem(path);
  if (problem !== undefined) {
    throw new Error(problem);
  }
};

/**
 * The places of a profile where generated files would not stay in the profile:
 * its folders, config and skill files, when links stand in their place.
 */
export const linkProblems = async (
  profile: OpenClawProfile,
): Promise<string[]> => {
  const skills = join(profile.workspace, 'skills');
  const problems: string[] = [];
  for (const path of [
    profile.dir,
    // OpenClaw creates the state folder later and would follow a link there.
    profile.stateDir,
    profile.workspace,
    skills,
    ...profile.skills.flatMap((name) => [
      join(skills, name),
      join(skills, name, 'SKILL.md'),
    ]),
    profile.configPath,
  ]) {
    const problem = await linkProblem(path);
    if (problem !== undefined) {
      problems.push(problem);
    }
  }
  return problems;
};

const refuseLinks = async (profile: OpenClawProfile): Promise<void> => {
  const [first] = await linkProblems(profile);
  if (first !== undefined) {
    throw new Error(first);
  }
};

const copySkill = async (
  name: string,
  target: string,
  options: WriteOptions,
  ollamaUrl: string,
): Promise<string[]> => {
  const source = join(skillsSource(options.repoRoot), name);
  const written: string[] = [];
  for (const relative of await readdir(source, { recursive: true })) {
    const from = join(source, relative);
    const to = join(target, relative);
    const content = await readFile(from).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'EISDIR') {
          return undefined;
        }
        throw error;
      },
    );
    if (content === undefined) {
      await mkdir(to, { recursive: true });
      continue;
    }
    await mkdir(dirname(to), { recursive: true });
    await refuseLink(to);
    // Beside and renamed, so that something put in the place of the file
    // after the check above is replaced, never written through.
    await writeBeside(
      to,
      relative.toLowerCase().endsWith('.md')
        ? renderSkillFile(content.toString('utf8'), options, ollamaUrl)
        : content,
      false,
    );
    written.push(to);
  }
  return written;
};

/** The Ollama server that a profile's config points at. */
const ollamaUrlOf = (profile: OpenClawProfile): string => {
  const url = (
    profile.config['models'] as
      | { providers?: { ollama?: { baseUrl?: unknown } } }
      | undefined
  )?.providers?.ollama?.baseUrl;
  return typeof url === 'string' ? url : 'http://127.0.0.1:11434';
};

/**
 * Writes a file that holds the gateway token: private where the OS allows, and
 * never half written (the token would be lost with it). It is written beside
 * its final place and renamed over it. The temporary name is not guessable and
 * the file must not exist yet, so a link that somebody left there can never
 * carry the write elsewhere.
 */
const writeBeside = async (
  path: string,
  content: string | Uint8Array,
  privately: boolean,
): Promise<void> => {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(
      temporary,
      content,
      privately ? { flag: 'wx', mode: 0o600 } : { flag: 'wx' },
    );
    // The mode above only applies to a file that is created, and the token
    // must not stay readable by others: failing to tighten it is an error.
    // (Windows has no POSIX modes to set.)
    if (privately && process.platform !== 'win32') {
      await chmod(temporary, 0o600);
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

const writePrivateFile = (path: string, content: string): Promise<void> =>
  writeBeside(path, content, true);

const writeProfile = async (
  profile: OpenClawProfile,
  options: WriteOptions,
): Promise<string[]> => {
  const written: string[] = [];
  await mkdir(profile.workspace, { recursive: true });

  // Drop skills of this repository that the profile must not have, so that
  // regenerating can never leave the knowledge skill in the web workspace.
  const skillsDirectory = join(profile.workspace, 'skills');
  const known = await namesIn(skillsSource(options.repoRoot));
  for (const name of await namesIn(skillsDirectory, true)) {
    if (hasName(known, name) && !hasName(profile.skills, name)) {
      await rm(join(skillsDirectory, name), { force: true, recursive: true });
    }
  }
  for (const name of profile.skills) {
    written.push(
      ...(await copySkill(
        name,
        join(skillsDirectory, name),
        options,
        ollamaUrlOf(profile),
      )),
    );
  }

  // Regenerating replaces the config: whatever a person added to it by hand
  // is kept in the previous copy, `openclaw.json.bak`.
  const content = `${JSON.stringify(profile.config, null, 2)}\n`;
  const previous = await readFile(profile.configPath, 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    },
  );
  const backup = `${profile.configPath}.bak`;
  if (previous !== undefined && previous !== content) {
    await writePrivateFile(backup, previous);
  } else if (process.platform !== 'win32') {
    // An earlier backup holds a token too: it must not stay readable by others.
    // A link in its place would carry the change to its target: refuse it.
    await refuseLink(backup);
    await chmod(backup, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
  await writePrivateFile(profile.configPath, content);
  written.push(profile.configPath);
  return written;
};

/**
 * Writes both profiles: the config file and a workspace holding only the
 * skills of that profile. State directories are left to OpenClaw. Running it
 * again rewrites the same files.
 */
export const writeProfiles = async (
  set: ProfileSet,
  options: WriteOptions,
): Promise<string[]> => {
  // Check everything first, so that a refused link leaves nothing half done.
  for (const profile of [set.web, set.knowledge]) {
    await refuseLinks(profile);
  }
  const written: string[] = [];
  for (const profile of [set.web, set.knowledge]) {
    written.push(...(await writeProfile(profile, options)));
  }
  return written;
};

/** Tokens of an earlier run, so regenerating keeps running clients working. */
export const readExistingTokens = async (
  set: ProfileSet,
): Promise<{ web?: string; knowledge?: string }> => {
  const tokens: { web?: string; knowledge?: string } = {};
  for (const profile of [set.web, set.knowledge]) {
    try {
      const parsed = JSON.parse(await readFile(profile.configPath, 'utf8')) as {
        gateway?: { auth?: { token?: unknown } };
      };
      const token = parsed.gateway?.auth?.token;
      if (typeof token === 'string' && token.length >= 16) {
        tokens[profile.name] = token;
      }
    } catch {
      // No earlier config, or one we cannot read: a new token is made.
    }
  }
  // One secret for both gateways would defeat their separation: keep the
  // web one and let the knowledge profile get a new one.
  if (tokens.web !== undefined && tokens.web === tokens.knowledge) {
    delete tokens.knowledge;
  }
  return tokens;
};
