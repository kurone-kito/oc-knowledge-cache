import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp.mts';
import {
  type GenerateOptions,
  generateProfiles,
  layoutProblem,
  prepareProfiles,
} from './generate.mts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const optionsIn = (root: string): GenerateOptions => ({
  dataDir: join(root, 'data'),
  model: 'test-model:latest',
  ollamaUrl: 'http://127.0.0.1:11434',
  outDir: join(root, 'openclaw'),
  repoRoot,
});

/** Tokens "t1", "t2", ... padded to the 16 characters that are required. */
const counter = () => {
  let n = 0;
  return () => `token-${String(++n).padStart(10, '0')}`;
};

describe('prepareProfiles / generateProfiles', () => {
  it('writes the profiles and keeps their tokens when run again', async (t) => {
    const root = await tempDir(t);
    const first = await generateProfiles(optionsIn(root), counter());
    // What was written, read before the second run can touch it.
    const before = {
      knowledge: JSON.parse(
        await readFile(first.set.knowledge.configPath, 'utf8'),
      ),
      web: JSON.parse(await readFile(first.set.web.configPath, 'utf8')),
    };
    // A different token source: only the tokens on disk can keep the old ones.
    let other = 100;
    const second = await generateProfiles(
      optionsIn(root),
      () => `other-token-${String(other++).padStart(12, '0')}`,
    );

    for (const name of ['web', 'knowledge'] as const) {
      const after = JSON.parse(
        await readFile(second.set[name].configPath, 'utf8'),
      );
      assert.deepEqual(after, before[name], `${name} is unchanged`);
    }
    assert.notEqual(
      before.web.gateway.auth.token,
      before.knowledge.gateway.auth.token,
    );
    assert.equal(second.written.length, first.written.length);
  });

  it('gives each gateway its own new token the first time', async (t) => {
    const root = await tempDir(t);
    const set = await prepareProfiles(optionsIn(root), counter());
    const tokens = [set.web, set.knowledge].map(
      (p) => (p.config['gateway'] as { auth: { token: string } }).auth.token,
    );
    assert.equal(new Set(tokens).size, 2);
  });

  it('writes nothing when it only prepares', async (t) => {
    const root = await tempDir(t);
    const set = await prepareProfiles(optionsIn(root), counter());
    await assert.rejects(readFile(set.web.configPath), /ENOENT/);
  });

  it('picks up a new model without losing the tokens', async (t) => {
    const root = await tempDir(t);
    const first = await generateProfiles(optionsIn(root), counter());
    const second = await generateProfiles(
      { ...optionsIn(root), model: 'other-model:latest' },
      counter(),
    );
    const token = (set: typeof first.set) =>
      (set.knowledge.config['gateway'] as { auth: { token: string } }).auth
        .token;
    assert.equal(token(second.set), token(first.set));
    assert.match(
      await readFile(second.set.knowledge.configPath, 'utf8'),
      /ollama\/other-model:latest/,
    );
  });
});

describe('layoutProblem', () => {
  it('accepts a layout that can be isolated and names one that cannot', () => {
    const base = optionsIn('/work/kc');
    assert.equal(layoutProblem(base), undefined);
    // Profiles inside the data directory.
    assert.match(
      layoutProblem({ ...base, outDir: '/work/kc/data/profiles' }) ?? '',
      /inside the data directory/,
    );
    // The same folder for both.
    assert.match(
      layoutProblem({ ...base, outDir: base.dataDir }) ?? '',
      /inside the data directory/,
    );
    // A project directory that is, or contains, a profile.
    assert.match(
      layoutProblem({ ...base, projectRepo: join(base.outDir, 'web') }) ?? '',
      /overlap/,
    );
    assert.match(
      layoutProblem({ ...base, projectRepo: base.outDir }) ?? '',
      /overlap/,
    );
  });
});

describe('prepareProfiles with links', () => {
  it('refuses an output folder that is a link into the data directory', async (t) => {
    const root = await tempDir(t);
    const data = join(root, 'data');
    await mkdir(data);
    try {
      await symlink(
        data,
        join(root, 'out-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      t.skip('links cannot be created here');
      return;
    }
    await assert.rejects(
      prepareProfiles({
        ...optionsIn(root),
        dataDir: data,
        outDir: join(root, 'out-link', 'p'),
      }),
      /inside the data directory/,
    );
  });

  it('refuses a profile folder that is a link into the data directory, and leaves the cache alone', async (t) => {
    const root = await tempDir(t);
    const data = join(root, 'data');
    const out = join(root, 'openclaw');
    await mkdir(data);
    await mkdir(out);
    try {
      await symlink(
        data,
        join(out, 'web'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      t.skip('links cannot be created here');
      return;
    }
    await assert.rejects(
      generateProfiles({ ...optionsIn(root), dataDir: data, outDir: out }),
      /is a link; refusing to write/,
    );
    assert.deepEqual(await readdir(data), []);
  });

  it('refuses a project repository that is a link to a profile folder', async (t) => {
    const root = await tempDir(t);
    const out = join(root, 'openclaw');
    await mkdir(join(out, 'web'), { recursive: true });
    try {
      await symlink(
        join(out, 'web'),
        join(root, 'repo-link'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      t.skip('links cannot be created here');
      return;
    }
    await assert.rejects(
      prepareProfiles({
        ...optionsIn(root),
        outDir: out,
        projectRepo: join(root, 'repo-link'),
      }),
      /overlap/,
    );
  });
});
