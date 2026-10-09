import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { realPathOf } from '../openclaw/paths.mts';
import { tempDir } from '../shared/temp.mts';

type Context = Parameters<typeof tempDir>[0];

const script = (name: string): string =>
  fileURLToPath(new URL(`./${name}.mts`, import.meta.url));

/** Runs a CLI in `cwd` with `KC_DATA_DIR` set to `dataEnv`, or not set at all. */
const run = (
  name: string,
  args: readonly string[],
  cwd: string,
  dataEnv?: string,
) => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'KC_DATA_DIR') {
      env[key] = value;
    }
  }
  if (dataEnv !== undefined) {
    env['KC_DATA_DIR'] = dataEnv;
  }
  return spawnSync(process.execPath, [script(name), ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
};

const forward = (path: string): string => path.replaceAll('\\', '/');

describe('nas:scan data folder', () => {
  const scan = async (t: Context, args: string[], dataEnv?: string) => {
    const root = await tempDir(t);
    await mkdir(join(root, 'share'));
    await writeFile(join(root, 'share', 'a.md'), '# a\n');
    const result = run(
      'nas-scan',
      ['--source', 'share', ...args],
      root,
      dataEnv,
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  it('reads the manifest from KC_DATA_DIR', async (t) => {
    const out = await scan(t, [], 'from-env');
    assert.ok(out.includes(join('from-env', 'manifest.json')), out);
  });

  it('prefers --data to KC_DATA_DIR', async (t) => {
    const out = await scan(t, ['--data', 'from-option'], 'from-env');
    assert.ok(out.includes(join('from-option', 'manifest.json')), out);
    assert.ok(!out.includes('from-env'), out);
  });

  it('falls back to .data', async (t) => {
    const out = await scan(t, []);
    assert.ok(out.includes(join('.data', 'manifest.json')), out);
  });
});

describe('openclaw:generate data folder', () => {
  /** The data folder the generated knowledge skill points the agent at. */
  const generated = async (
    t: Context,
    args: string[],
    dataEnv?: string,
  ): Promise<{ root: string; skill: string }> => {
    const root = await tempDir(t);
    await mkdir(join(root, 'project'));
    const result = run(
      'openclaw-generate',
      [
        '--model',
        'test-model:latest',
        '--out',
        'profiles',
        '--project-repo',
        'project',
        ...args,
      ],
      root,
      dataEnv,
    );
    assert.equal(result.status, 0, result.stderr);
    const skill = await readFile(
      join(
        root,
        'profiles',
        'knowledge',
        'workspace',
        'skills',
        'knowledge-search',
        'SKILL.md',
      ),
      'utf8',
    );
    return { root, skill };
  };

  const entry = (dataDir: string): string =>
    `"KC_DATA_DIR": "${forward(dataDir)}"`;

  it('points the agent at KC_DATA_DIR', async (t) => {
    const { root, skill } = await generated(t, [], 'from-env');
    assert.ok(
      skill.includes(entry(join(await realPathOf(root), 'from-env'))),
      skill,
    );
  });

  it('prefers --data to KC_DATA_DIR', async (t) => {
    const { root, skill } = await generated(
      t,
      ['--data', 'from-option'],
      'from-env',
    );
    assert.ok(
      skill.includes(entry(join(await realPathOf(root), 'from-option'))),
      skill,
    );
  });

  it('falls back to .data', async (t) => {
    const { root, skill } = await generated(t, []);
    assert.ok(
      skill.includes(entry(join(await realPathOf(root), '.data'))),
      skill,
    );
  });
});
