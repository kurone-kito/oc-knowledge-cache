import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

/** Creates a temporary directory that is removed when the test ends. */
export const tempDir = async (t: TestContext): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'kc-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
};

/** Writes a file (creating folders) and pins its modification time. */
export const putFile = async (
  root: string,
  relativePath: string,
  content: string | Uint8Array,
  mtimeSeconds = 1_700_000_000,
): Promise<string> => {
  const file = join(root, ...relativePath.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  await utimes(file, mtimeSeconds, mtimeSeconds);
  return file;
};
