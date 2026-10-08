import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { buildProfiles } from './profiles.mts';
import { quotePosix, quotePowerShell, startCommands } from './shell.mts';

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
