import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { tempDir } from '../shared/temp.mts';
import {
  diffManifest,
  emptyManifest,
  loadManifest,
  type Manifest,
  type ManifestEntry,
  saveManifest,
  withEntry,
  withoutEntry,
} from './manifest.mts';

/** Builds an entry whose hash is the label's hex code, padded to 64 digits. */
const entry = (label: string, size = 1, mtimeMs = 1): ManifestEntry => ({
  mtimeMs,
  sha256: Buffer.from(label).toString('hex').padEnd(64, '0'),
  size,
});

const manifest = (entries: Record<string, ManifestEntry>): Manifest => ({
  entries,
  version: 1,
});

describe('diffManifest', () => {
  it('sorts paths into added, changed, removed and unchanged', () => {
    const previous = manifest({
      'gone.md': entry('g'),
      'same.md': entry('s'),
      'edited.md': entry('e1'),
    });
    const current = manifest({
      'edited.md': entry('e2'),
      'new.md': entry('n'),
      'same.md': entry('s'),
    });
    assert.deepEqual(diffManifest(previous, current), {
      added: ['new.md'],
      changed: ['edited.md'],
      removed: ['gone.md'],
      unchanged: ['same.md'],
    });
  });

  it('treats a changed mtime with identical content as unchanged', () => {
    const diff = diffManifest(
      manifest({ 'a.md': entry('same', 1, 1) }),
      manifest({ 'a.md': entry('same', 1, 2) }),
    );
    assert.deepEqual(diff.unchanged, ['a.md']);
    assert.deepEqual(diff.changed, []);
  });

  it('treats a rename as a removal plus an addition', () => {
    const diff = diffManifest(
      manifest({ 'old.md': entry('h') }),
      manifest({ 'new.md': entry('h') }),
    );
    assert.deepEqual(diff.removed, ['old.md']);
    assert.deepEqual(diff.added, ['new.md']);
  });

  it('reports everything as added against an empty manifest', () => {
    const diff = diffManifest(
      emptyManifest(),
      manifest({ 'a.md': entry('a') }),
    );
    assert.deepEqual(diff.added, ['a.md']);
  });
});

describe('withEntry / withoutEntry', () => {
  it('return updated copies without mutating the input', () => {
    const base = manifest({ 'a.md': entry('a') });
    const added = withEntry(base, 'b.md', entry('b'));
    assert.deepEqual(Object.keys(added.entries), ['a.md', 'b.md']);
    assert.deepEqual(Object.keys(base.entries), ['a.md']);
    assert.deepEqual(Object.keys(withoutEntry(added, 'a.md').entries), [
      'b.md',
    ]);
    assert.deepEqual(Object.keys(withoutEntry(base, 'missing.md').entries), [
      'a.md',
    ]);
  });
});

describe('manifest persistence', () => {
  it('round-trips through disk with sorted keys', async (t) => {
    const dir = await tempDir(t);
    const file = join(dir, 'nested', 'manifest.json');
    const original = manifest({ 'b.md': entry('b'), 'a.md': entry('a') });
    await saveManifest(file, original);

    assert.deepEqual(await loadManifest(file), original);
    const written = JSON.parse(await readFile(file, 'utf8')) as Manifest;
    assert.deepEqual(Object.keys(written.entries), ['a.md', 'b.md']);
  });

  it('treats a missing file as an empty manifest', async (t) => {
    const dir = await tempDir(t);
    assert.deepEqual(
      await loadManifest(join(dir, 'none.json')),
      emptyManifest(),
    );
  });

  it('leaves no temporary files behind and replaces an existing file', async (t) => {
    const dir = await tempDir(t);
    const file = join(dir, 'manifest.json');
    await saveManifest(file, manifest({ 'a.md': entry('1') }));
    await saveManifest(file, manifest({ 'a.md': entry('2') }));
    assert.deepEqual(await readdir(dir), ['manifest.json']);
    assert.deepEqual((await loadManifest(file)).entries['a.md'], entry('2'));
  });

  it('rejects corrupt or unsupported files with a helpful message', async (t) => {
    const dir = await tempDir(t);
    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{ not json');
    await assert.rejects(loadManifest(broken), /not valid JSON/);

    for (const [name, content] of [
      ['null', 'null'],
      ['number', '42'],
      ['text', '"manifest"'],
    ] as const) {
      const file = join(dir, `${name}.json`);
      await writeFile(file, content);
      await assert.rejects(loadManifest(file), /unsupported format/, name);
    }

    const future = join(dir, 'future.json');
    await writeFile(future, JSON.stringify({ entries: {}, version: 2 }));
    await assert.rejects(loadManifest(future), /unsupported format/);

    const malformed = join(dir, 'malformed.json');
    await writeFile(
      malformed,
      JSON.stringify({ entries: { 'a.md': { size: 'big' } }, version: 1 }),
    );
    await assert.rejects(loadManifest(malformed), /unsupported format/);

    const badHash = join(dir, 'bad-hash.json');
    await writeFile(
      badHash,
      JSON.stringify({
        entries: { 'a.md': { mtimeMs: 1, sha256: 'x', size: 1 } },
        version: 1,
      }),
    );
    await assert.rejects(loadManifest(badHash), /unsupported format/);

    const arrayEntries = join(dir, 'array.json');
    await writeFile(arrayEntries, JSON.stringify({ entries: [], version: 1 }));
    await assert.rejects(loadManifest(arrayEntries), /unsupported format/);
  });
});
