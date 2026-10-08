import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { optionalNumber, scriptArgs } from './options.mts';

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
