import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp.mts';
import { buildProfiles } from './profiles.mts';
import {
  profileEnv,
  type RunWithEnv,
  resolveOpenClawCommand,
  runWithEnv,
  spawnPlan,
  validateWithOpenClaw,
} from './validate.mts';
import { writeProfiles } from './write.mts';

const profile = buildProfiles({
  dataDir: '/srv/kc/.data',
  model: 'm',
  ollamaUrl: 'http://127.0.0.1:11434',
  outDir: '/srv/kc/.openclaw',
  repoRoot: '/srv/kc',
  tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
}).web;

describe('validateWithOpenClaw', () => {
  it('runs `config validate --json` against the profile only', async () => {
    const calls: { command: readonly string[]; env: Record<string, string> }[] =
      [];
    const run: RunWithEnv = async (command, env) => {
      calls.push({ command, env: { ...env } });
      return '{"valid":true,"warnings":[]}';
    };
    const result = await validateWithOpenClaw(profile, ['openclaw'], run);
    assert.deepEqual(result, { detail: '', valid: true });
    assert.deepEqual(calls[0]?.command, [
      'openclaw',
      'config',
      'validate',
      '--json',
    ]);
    assert.deepEqual(calls[0]?.env, profileEnv(profile));
    assert.equal(calls[0]?.env['OPENCLAW_STATE_DIR'], profile.stateDir);
  });

  it('reports the issues of an invalid config, also when the CLI exits non-zero', async () => {
    const run: RunWithEnv = async () => {
      throw Object.assign(new Error('exit 1'), {
        stdout:
          '{"valid":false,"issues":[{"path":"<root>","message":"Unrecognized key: \\"bogus\\""}]}',
      });
    };
    const result = await validateWithOpenClaw(profile, ['openclaw'], run);
    assert.equal(result.valid, false);
    assert.match(result.detail, /<root>: Unrecognized key/);
  });

  it('says so when the CLI cannot be run or prints nonsense', async () => {
    const missing = await validateWithOpenClaw(
      profile,
      ['openclaw'],
      async () => {
        throw new Error('spawn openclaw ENOENT');
      },
    );
    assert.equal(missing.valid, false);
    assert.match(
      missing.detail,
      /Could not run openclaw: spawn openclaw ENOENT/,
    );

    const odd = await validateWithOpenClaw(
      profile,
      ['openclaw'],
      async () => 'hello',
    );
    assert.equal(odd.valid, false);
    assert.match(odd.detail, /Unexpected output/);
  });
});

/**
 * Optional conformance check against the real OpenClaw CLI. Set
 * KC_OPENCLAW_CLI to the `openclaw` executable or to its `openclaw.mjs`.
 */
describe('generated configs against the real OpenClaw CLI', () => {
  const cli = process.env['KC_OPENCLAW_CLI'];

  it('are accepted by `openclaw config validate`', {
    skip: cli === undefined,
  }, async (t) => {
    const root = await tempDir(t);
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    const set = buildProfiles({
      dataDir: join(root, 'data'),
      model: 'qwen3.6:35b-a3b-coding',
      ollamaUrl: 'http://127.0.0.1:11434',
      outDir: join(root, 'openclaw'),
      projectRepo: join(root, 'project'),
      repoRoot,
      tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
    });
    await writeProfiles(set, { dataDir: join(root, 'data'), repoRoot });
    const command = cli?.endsWith('.mjs')
      ? [process.execPath, cli]
      : [cli as string];
    for (const entry of [set.web, set.knowledge]) {
      const result = await validateWithOpenClaw(entry, command, runWithEnv);
      assert.deepEqual(result, { detail: '', valid: true }, entry.name);
    }
  });
});

describe('resolveOpenClawCommand', () => {
  it('defaults to openclaw on the PATH', () => {
    assert.deepEqual(resolveOpenClawCommand({}), ['openclaw']);
    assert.deepEqual(resolveOpenClawCommand({ KC_OPENCLAW_CLI: '  ' }), [
      'openclaw',
    ]);
  });

  it('runs an openclaw.mjs with the current Node.js and keeps other paths whole', () => {
    assert.deepEqual(
      resolveOpenClawCommand({ KC_OPENCLAW_CLI: 'C:/my tools/openclaw.mjs' }),
      [process.execPath, 'C:/my tools/openclaw.mjs'],
    );
    assert.deepEqual(
      resolveOpenClawCommand({ KC_OPENCLAW_CLI: '/opt/bin/openclaw' }),
      ['/opt/bin/openclaw'],
    );
  });
});

describe('spawnPlan', () => {
  it('starts npm shims and bare names through the shell on Windows', () => {
    assert.deepEqual(spawnPlan('openclaw', 'win32'), {
      file: 'openclaw',
      shell: true,
    });
    assert.deepEqual(spawnPlan('C:/npm/openclaw.cmd', 'win32'), {
      file: 'C:/npm/openclaw.cmd',
      shell: true,
    });
    assert.deepEqual(spawnPlan('C:/Program Files/npm/openclaw.cmd', 'win32'), {
      file: '"C:/Program Files/npm/openclaw.cmd"',
      shell: true,
    });
  });

  it('quotes a path that contains shell metacharacters', () => {
    for (const path of [
      'C:/tools & more/openclaw.cmd',
      'C:/tools(x86)/openclaw.cmd',
      'C:/a^b/openclaw.cmd',
    ]) {
      assert.deepEqual(spawnPlan(path, 'win32'), {
        file: `"${path}"`,
        shell: true,
      });
    }
    assert.equal(
      spawnPlan('C:/npm-global/open_claw.cmd', 'win32').file,
      'C:/npm-global/open_claw.cmd',
    );
  });

  it('refuses a path that cmd.exe would expand, only where cmd.exe is used', () => {
    assert.throws(
      () => spawnPlan('C:/tools/100%bin%/openclaw.cmd', 'win32'),
      /cmd\.exe would expand/,
    );
    assert.doesNotThrow(() => spawnPlan('/opt/100%bin%/openclaw', 'linux'));
    assert.doesNotThrow(() => spawnPlan('C:/tools/100%bin%/node.exe', 'win32'));
  });

  it('starts real executables directly, everywhere', () => {
    assert.deepEqual(spawnPlan('C:/Program Files/nodejs/node.exe', 'win32'), {
      file: 'C:/Program Files/nodejs/node.exe',
      shell: false,
    });
    assert.deepEqual(spawnPlan('openclaw', 'linux'), {
      file: 'openclaw',
      shell: false,
    });
    assert.deepEqual(spawnPlan('/opt/bin/openclaw', 'darwin'), {
      file: '/opt/bin/openclaw',
      shell: false,
    });
  });

  it('runs a shim-style command for real', async () => {
    // pnpm is a .cmd shim on Windows and a script elsewhere: both must start.
    const out = await runWithEnv(['pnpm', '--version'], {});
    assert.match(out.trim(), /^\d+\.\d+/);
  });
});

describe('runWithEnv', () => {
  it('starts a .cmd shim through the shell, in a folder with a space, with the given environment', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('only Windows needs the shell for shims');
      return;
    }
    const dir = join(await tempDir(t), 'with space');
    await mkdir(dir);
    const shim = join(dir, 'fake-openclaw.cmd');
    await writeFile(shim, '@echo off\r\necho %KC_TEST_VALUE% %1 %2\r\n');
    const out = await runWithEnv([shim, 'config', 'validate'], {
      KC_TEST_VALUE: 'seen',
    });
    assert.equal(out.trim(), 'seen config validate');
  });
});
