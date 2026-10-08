import { lstat, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** More links than any real layout has: a loop. */
const MAX_LINK_DEPTH = 32;

/**
 * The real location of a path that may not exist yet: symbolic links in the
 * part that does exist are resolved and the rest is appended. A link whose
 * target does not exist yet is followed as well, because creating the path
 * later would write at the target. The isolation of the two profiles is judged
 * on this, not on how the paths are spelled: a link from the output folder
 * into the cache would otherwise put the web workspace next to the cache.
 */
export const realPathOf = async (path: string, depth = 0): Promise<string> => {
  if (depth > MAX_LINK_DEPTH) {
    throw new Error(`Too many levels of links while resolving ${path}`);
  }
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...[...missing].reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const info = await lstat(current).catch(() => undefined);
      if (info?.isSymbolicLink()) {
        // Dangling link: where it points is where the path will come to exist.
        const target = resolve(dirname(current), await readlink(current));
        return join(
          await realPathOf(target, depth + 1),
          ...[...missing].reverse(),
        );
      }
      const parent = dirname(current);
      if (parent === current) {
        return absolute;
      }
      missing.push(basename(current));
      current = parent;
    }
  }
};
