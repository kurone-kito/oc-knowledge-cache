import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  optionalNumber,
  resolveDataDir,
  resolveQuestion,
  scriptArgs,
} from './options.mts';

describe('optionalNumber', () => {
  it('returns undefined when the option is absent', () => {
    assert.equal(optionalNumber('top', undefined), undefined);
  });

  it('parses numbers', () => {
    assert.equal(optionalNumber('vram-gib', '8'), 8);
    assert.equal(optionalNumber('vram-gib', '0'), 0);
    assert.equal(optionalNumber('ram-gib', '63.8'), 63.8);
  });

  it('rejects fractions only when an integer is required', () => {
    assert.equal(optionalNumber('ram-gib', '1.5'), 1.5);
    assert.equal(optionalNumber('top', '3', { integer: true }), 3);
    assert.throws(
      () => optionalNumber('top', '1.5', { integer: true }),
      /--top must be an integer >= 0, got "1.5"/,
    );
  });

  it('enforces an upper bound when given', () => {
    assert.equal(optionalNumber('min-score', '0.5', { max: 1 }), 0.5);
    assert.equal(optionalNumber('min-score', '1', { max: 1 }), 1);
    assert.throws(
      () => optionalNumber('min-score', '2', { max: 1 }),
      /--min-score must be a number from 0 to 1, got "2"/,
    );
  });

  it('rejects garbage, blanks and values below the minimum', () => {
    assert.throws(
      () => optionalNumber('top', 'abc'),
      /--top must be a number >= 0/,
    );
    assert.throws(() => optionalNumber('top', ' '), /--top/);
    assert.throws(() => optionalNumber('top', '-1'), /--top/);
    assert.throws(
      () => optionalNumber('top', '0', { min: 1 }),
      /--top must be a number >= 1/,
    );
  });
});

describe('scriptArgs', () => {
  it('drops the separator that pnpm forwards', () => {
    assert.deepEqual(scriptArgs(['--', '--json']), ['--json']);
  });

  it('leaves other arguments alone', () => {
    assert.deepEqual(scriptArgs(['--json', '--', 'x']), ['--json', '--', 'x']);
    assert.deepEqual(scriptArgs([]), []);
  });
});

describe('resolveQuestion', () => {
  it('joins the words on the command line', () => {
    assert.equal(
      resolveQuestion(['ログイン', ' 画面 '], undefined, {}),
      'ログイン  画面',
    );
  });

  it('reads the question from the named environment variable', () => {
    const nasty = 'what is "x"; $(rm -rf /) `id`';
    assert.equal(
      resolveQuestion([], 'KC_QUESTION', {
        KC_QUESTION: `  ${nasty}
`,
      }),
      nasty,
    );
  });

  it('is empty when the variable is missing, and refuses both ways at once', () => {
    assert.equal(resolveQuestion([], 'KC_QUESTION', {}), '');
    assert.throws(
      () => resolveQuestion(['words'], 'KC_QUESTION', { KC_QUESTION: 'x' }),
      /either as words or in \$KC_QUESTION/,
    );
  });
});

describe('resolveDataDir', () => {
  it('prefers the option, then KC_DATA_DIR, then .data', () => {
    assert.equal(resolveDataDir('a', { KC_DATA_DIR: 'b' }), 'a');
    assert.equal(resolveDataDir(undefined, { KC_DATA_DIR: 'b' }), 'b');
    assert.equal(resolveDataDir(undefined, {}), '.data');
  });
});
