import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  outcomeOf,
  TRIAGE_SAMPLES,
  type TriageOutcome,
} from './triage-samples.mts';

describe('triage samples', () => {
  it('have unique ids and requests', () => {
    assert.equal(
      new Set(TRIAGE_SAMPLES.map((sample) => sample.id)).size,
      TRIAGE_SAMPLES.length,
    );
    assert.equal(
      new Set(TRIAGE_SAMPLES.map((sample) => sample.request)).size,
      TRIAGE_SAMPLES.length,
    );
  });

  it('cover every outcome at least twice and both languages for each', () => {
    for (const outcome of [1, 2, 3] as const) {
      const own = TRIAGE_SAMPLES.filter(
        (sample) => sample.expected === outcome,
      );
      assert.ok(own.length >= 2, `outcome ${outcome} has two samples`);
      assert.deepEqual(
        [...new Set(own.map((sample) => sample.language))].sort(),
        ['en', 'ja'],
        `outcome ${outcome} in both languages`,
      );
    }
  });

  it('hold the mail review of #34 as a new capability', () => {
    const sample = TRIAGE_SAMPLES.find(
      (candidate) => candidate.id === 'new-mail-review-en',
    );
    assert.equal(sample?.expected, 3);
    assert.match(sample?.request ?? '', /mail/);
    assert.match(sample?.request ?? '', /ledger/);
    assert.match(sample?.request ?? '', /reply/);
  });
});

describe('outcomeOf', () => {
  it('reads the outcome of an answer in the form of the skill', () => {
    const cases: [string, TriageOutcome | undefined][] = [
      ['Outcome: 3 (new capability)\nWhy: mail', 3],
      ['Outcome: 1 (do it now)', 1],
      ['**Outcome:** 2 (compose)', 2],
      ['Outcome: **2** (compose)', 2],
      ['The outcome is new.', undefined],
      ['Outcome: 4', undefined],
      // A quotation inside another line is not the outcome line.
      ['Why: the expected Outcome: 3 was a guess', undefined],
      ['Intro\nWhy: it says Outcome: 3\nOutcome: 2 (compose)', 2],
    ];
    for (const [answer, expected] of cases) {
      assert.equal(outcomeOf(answer), expected, answer);
    }
  });
});
