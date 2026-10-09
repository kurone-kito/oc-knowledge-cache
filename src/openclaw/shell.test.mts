import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { buildProfiles } from './profiles.mts';
import {
  afterGeneration,
  quotePosix,
  quotePowerShell,
  startCommands,
  tuiCommands,
} from './shell.mts';

describe('quotePosix', () => {
  it('wraps a value in single quotes and escapes the quotes inside', () => {
    assert.equal(quotePosix('/a/b'), "'/a/b'");
    assert.equal(quotePosix("it's"), String.raw`'it'\''s'`);
    assert.equal(
      quotePosix('$(rm -rf /) `id` "x"'),
      '\'$(rm -rf /) `id` "x"\'',
    );
  });

  it('is read back unchanged by a real POSIX shell', (t) => {
    if (process.platform === 'win32') {
      t.skip('needs a POSIX shell');
      return;
    }
    for (const value of [
      "it's",
      '$(echo pwned) `id`',
      'a b\tc',
      '"q"',
      '日本語',
    ]) {
      const echoed = execFileSync(
        'sh',
        ['-c', `printf %s ${quotePosix(value)}`],
        {
          encoding: 'utf8',
        },
      );
      assert.equal(echoed, value);
    }
  });
});

describe('quotePowerShell', () => {
  it('wraps a value in single quotes and doubles the quotes inside', () => {
    assert.equal(quotePowerShell('C:/a b'), "'C:/a b'");
    assert.equal(quotePowerShell("it's"), "'it''s'");
    assert.equal(quotePowerShell('$env:X; calc'), "'$env:X; calc'");
  });
});

describe('startCommands', () => {
  it('quotes the paths for both shells', () => {
    const set = buildProfiles({
      dataDir: '/srv/kc/.data',
      model: 'm',
      ollamaUrl: 'http://127.0.0.1:11434',
      outDir: "/srv/my'dir/profiles",
      repoRoot: '/srv/kc',
      tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
    });
    const lines = startCommands(set.web);
    assert.equal(lines[0], '# web');
    assert.match(
      lines[1] ?? '',
      /^PowerShell: {2}\$env:OPENCLAW_CONFIG_PATH='.*my''dir/,
    );
    assert.match(
      lines[2] ?? '',
      /^POSIX shell: OPENCLAW_CONFIG_PATH='.*my'\\''dir/,
    );
    assert.ok(lines.every((line) => /--port 19100|^#/.test(line)));
  });
});

describe('tuiCommands', () => {
  const set = buildProfiles({
    dataDir: '/srv/kc/.data',
    model: 'm',
    ollamaUrl: 'http://127.0.0.1:11434',
    outDir: "/srv/my'dir/profiles",
    repoRoot: '/srv/kc',
    tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
  });

  it('opens the terminal UI and asks one question, in both shells', () => {
    const lines = tuiCommands(set.web);
    assert.deepEqual(
      lines.filter((line) => line.startsWith('#')),
      ['# web: terminal UI', '# web: one question'],
    );
    const tui = lines.filter((line) => line.endsWith('openclaw tui'));
    assert.equal(tui.length, 2);
    const ask = lines.filter((line) => line.includes('openclaw agent'));
    assert.equal(ask.length, 2);
    assert.ok(
      ask.every((line) =>
        line.endsWith('--agent research --timeout 900 --message "..."'),
      ),
      'the agent of the web profile, with the timeout of the README',
    );
  });

  it('quotes the paths like the start commands do', () => {
    const [, powerShell, posix] = tuiCommands(set.web);
    assert.match(
      powerShell ?? '',
      /^PowerShell: {2}\$env:OPENCLAW_CONFIG_PATH='.*my''dir.*openclaw\.json'; \$env:OPENCLAW_STATE_DIR='.*my''dir/,
    );
    assert.match(
      posix ?? '',
      /^POSIX shell: OPENCLAW_CONFIG_PATH='.*my'\\''dir.*openclaw\.json' OPENCLAW_STATE_DIR='.*my'\\''dir/,
    );
  });

  it('names the agent of each profile and sets the variables of that profile', () => {
    const knowledge = tuiCommands(set.knowledge).join('\n');
    assert.match(knowledge, /--agent knowledge --timeout 900 --message/);
    assert.ok(!knowledge.includes('/web/'), 'no path of the other profile');
    assert.ok(knowledge.includes('/knowledge/openclaw.json'));
    assert.ok(!knowledge.includes('--port'), 'the port comes from the config');
  });
});

describe('afterGeneration', () => {
  const set = buildProfiles({
    dataDir: '/srv/kc/.data',
    model: 'm',
    ollamaUrl: 'http://127.0.0.1:11434',
    outDir: '/srv/kc/.openclaw',
    repoRoot: '/srv/kc',
    tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
  });

  it('prints the heading, the start lines and then the lines for each profile to talk to it', () => {
    const lines = afterGeneration(set, 'Start them:');
    assert.equal(lines[0], 'Start them:');
    const text = lines.join('\n');
    // Each profile: a start line per shell, a terminal UI line per shell and
    // a one-question line per shell.
    assert.equal(text.split('openclaw gateway --port').length - 1, 4);
    assert.equal(
      lines.filter((line) => line.endsWith('openclaw tui')).length,
      4,
    );
    assert.equal(
      lines.filter((line) => line.includes('openclaw agent --agent')).length,
      4,
    );
    assert.ok(
      lines.indexOf('# web') < lines.indexOf('# web: terminal UI'),
      'the start lines come before the lines for talking',
    );
  });
});
