import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Compile-time only; Node must strip this without a build step. */
interface Versions {
  readonly node: string;
}

const REQUIRED_NODE_MAJOR = 26;

describe('test harness', () => {
  it('runs TypeScript test files directly on the required Node.js', () => {
    const versions: Versions = process.versions;
    const major = Number(versions.node.split('.')[0]);
    assert.ok(
      major >= REQUIRED_NODE_MAJOR,
      `Node.js ${REQUIRED_NODE_MAJOR}+ is required, got ${versions.node}`,
    );
  });
});
