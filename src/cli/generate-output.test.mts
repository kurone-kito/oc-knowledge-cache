import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp.mts';

const script = fileURLToPath(
  new URL('./openclaw-generate.mts', import.meta.url),
);

describe('openclaw:generate output', () => {
  it('prints, for each profile, how to start its gateway, open its terminal UI and ask it one question', async (t) => {
    const root = await tempDir(t);
    const result = spawnSync(
      process.execPath,
      [script, '--model', 'test-model:latest', '--out', 'profiles'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n');

    for (const [profile, agent, port] of [
      ['web', 'research', '19100'],
      ['knowledge', 'knowledge', '19300'],
    ] as const) {
      assert.ok(
        lines.some(
          (line) =>
            line.startsWith('POSIX shell:') &&
            line.endsWith(`openclaw gateway --port ${port}`),
        ),
        `${profile}: the start line`,
      );
      assert.ok(
        lines.some(
          (line) =>
            line.startsWith('POSIX shell:') &&
            line.includes(`/${profile}/openclaw.json`) &&
            line.endsWith('openclaw tui'),
        ),
        `${profile}: the terminal UI line`,
      );
      assert.ok(
        lines.some(
          (line) =>
            line.startsWith('PowerShell:') &&
            line.endsWith(
              `openclaw agent --agent ${agent} --timeout 900 --message "..."`,
            ),
        ),
        `${profile}: the one-question line`,
      );
    }
    const start = lines.findIndex((line) => line.startsWith('Start the two'));
    const talk = lines.findIndex((line) => line.startsWith('Talk to an'));
    assert.ok(start >= 0 && talk > start, 'start first, then talk');
  });
});
