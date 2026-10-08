import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from '../shared/temp.mts';
import { realPathOf } from './paths.mts';
import { buildProfiles } from './profiles.mts';

/** Makes a directory link (a junction on Windows, which needs no privilege). */
const link = async (target: string, path: string): Promise<boolean> => {
  try {
    await symlink(
      target,
      path,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return true;
  } catch {
    return false;
  }
};

describe('realPathOf', () => {
  it('returns an absolute path for something that does not exist', async (t) => {
    const root = await tempDir(t);
    const resolved = await realPathOf(join(root, 'a', 'b'));
    assert.equal(resolved, join(await realPathOf(root), 'a', 'b'));
  });

  it('resolves links in the part that exists and keeps the part that does not', async (t) => {
    const root = await tempDir(t);
    const real = join(root, 'real');
    await mkdir(real);
    if (!(await link(real, join(root, 'alias')))) {
      t.skip('links cannot be created here');
      return;
    }
    assert.equal(
      await realPathOf(join(root, 'alias', 'a', 'b')),
      join(await realPathOf(real), 'a', 'b'),
    );
  });
});

describe('realPathOf with a link that points nowhere yet', () => {
  it('follows the link, because creating the path would write at its target', async (t) => {
    const root = await tempDir(t);
    const future = join(root, 'future');
    if (!(await link(future, join(root, 'alias')))) {
      t.skip('links to a missing target cannot be created here');
      return;
    }
    const resolved = await realPathOf(join(root, 'alias', 'profiles'));
    assert.equal(resolved, join(await realPathOf(root), 'future', 'profiles'));
  });

  it('gives up on a loop of links', async (t) => {
    const root = await tempDir(t);
    if (
      !(await link(join(root, 'b'), join(root, 'a'))) ||
      !(await link(join(root, 'a'), join(root, 'b')))
    ) {
      t.skip('links cannot be created here');
      return;
    }
    await assert.rejects(realPathOf(join(root, 'a', 'x')), /links|ELOOP/);
  });
});

describe('profiles judged by their real location', () => {
  const input = (dataDir: string, outDir: string) => ({
    dataDir,
    model: 'm',
    ollamaUrl: 'http://127.0.0.1:11434',
    outDir,
    repoRoot: '/srv/kc',
    tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
  });

  it('refuses an output folder that is a link into the data directory', async (t) => {
    const root = await tempDir(t);
    const data = join(root, 'data');
    await mkdir(data);
    if (!(await link(data, join(root, 'out-link')))) {
      t.skip('links cannot be created here');
      return;
    }
    const dataDir = await realPathOf(data);
    const outDir = await realPathOf(join(root, 'out-link', 'profiles'));
    assert.throws(
      () => buildProfiles(input(dataDir, outDir)),
      /inside the data directory/,
    );
  });
});
