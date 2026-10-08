import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapLimit } from './concurrency.mts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('mapLimit', () => {
  it('returns results in input order', async () => {
    const result = await mapLimit([30, 1, 10], 3, async (n) => {
      for (let i = 0; i < n; i++) {
        await tick();
      }
      return n * 2;
    });
    assert.deepEqual(result, [60, 2, 20]);
  });

  it('never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    await mapLimit(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        running++;
        peak = Math.max(peak, running);
        await tick();
        await tick();
        running--;
      },
    );
    assert.equal(peak, 3);
  });

  it('treats an unusable limit as one at a time and Infinity as no limit', async () => {
    const seen: number[] = [];
    assert.deepEqual(
      await mapLimit([1, 2, 3], Number.NaN, async (x) => {
        seen.push(x);
        return x * 10;
      }),
      [10, 20, 30],
    );
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual(
      await mapLimit([1, 2, 3], Number.POSITIVE_INFINITY, async (x) => x),
      [1, 2, 3],
    );
  });

  it('handles empty input and a limit below one', async () => {
    assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
    assert.deepEqual(await mapLimit([1, 2], 0, async (x) => x + 1), [2, 3]);
  });

  it('rejects when a call rejects', async () => {
    await assert.rejects(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) {
          throw new Error('boom');
        }
        return n;
      }),
      /boom/,
    );
  });
});
