import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { putFile, tempDir } from '../shared/temp.mts';
import { type FileHasher, hashFile, scanChanges } from './changes.mts';
import { emptyManifest, type Manifest } from './manifest.mts';
import { realScanIo, type ScanIo } from './scan.mts';

/** Wraps the real hasher and records which files were read. */
const countingHasher = (): { hash: FileHasher; calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    hash: async (file) => {
      calls.push(file);
      return hashFile(file);
    },
  };
};

const baseline = async (root: string): Promise<Manifest> =>
  (await scanChanges(root, emptyManifest())).current;

describe('scanChanges', () => {
  it('reports every file as added on the first run', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'a.md', 'one');
    await putFile(root, 'dir/b.md', 'two');

    const { diff, current, errors } = await scanChanges(root, emptyManifest());
    assert.deepEqual(diff.added, ['a.md', 'dir/b.md']);
    assert.deepEqual(errors, []);
    assert.equal(current.entries['a.md']?.size, 3);
    assert.match(current.entries['a.md']?.sha256 ?? '', /^[0-9a-f]{64}$/);
  });

  it('reports nothing and hashes nothing when nothing changed', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'a.md', 'one');
    const previous = await baseline(root);

    const counter = countingHasher();
    const { diff } = await scanChanges(root, previous, { hash: counter.hash });
    assert.deepEqual(diff.unchanged, ['a.md']);
    assert.deepEqual([diff.added, diff.changed, diff.removed], [[], [], []]);
    assert.deepEqual(counter.calls, []);
  });

  it('detects a modified file', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'a.md', 'one');
    await putFile(root, 'b.md', 'two');
    const previous = await baseline(root);

    await putFile(root, 'a.md', 'one edited', 1_700_000_500);
    const { diff } = await scanChanges(root, previous);
    assert.deepEqual(diff.changed, ['a.md']);
    assert.deepEqual(diff.unchanged, ['b.md']);
  });

  it('treats a touched but identical file as unchanged and refreshes its mtime', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'a.md', 'same', 1_700_000_000);
    const previous = await baseline(root);

    await putFile(root, 'a.md', 'same', 1_700_009_999);
    const counter = countingHasher();
    const { diff, current } = await scanChanges(root, previous, {
      hash: counter.hash,
    });
    assert.deepEqual(diff.unchanged, ['a.md']);
    assert.equal(counter.calls.length, 1, 'content is re-read to confirm');
    assert.equal(current.entries['a.md']?.mtimeMs, 1_700_009_999_000);
  });

  it('detects deletions and renames', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'gone.md', 'bye');
    await putFile(root, 'old-name.md', 'same content');
    const previous = await baseline(root);

    await rm(join(root, 'gone.md'));
    await rm(join(root, 'old-name.md'));
    await putFile(root, 'new-name.md', 'same content');

    const { diff } = await scanChanges(root, previous);
    assert.deepEqual(diff.removed, ['gone.md', 'old-name.md']);
    assert.deepEqual(diff.added, ['new-name.md']);
  });

  it('keeps the old state of a file that is unreadable right now', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'open-in-excel.md', 'v1');
    await putFile(root, 'other.md', 'x');
    const previous = await baseline(root);

    await putFile(root, 'open-in-excel.md', 'v2 longer', 1_700_000_900);
    const failing: FileHasher = async (file) => {
      if (file.endsWith('open-in-excel.md')) {
        throw new Error('EBUSY: file is locked');
      }
      return hashFile(file);
    };
    const { diff, current, errors } = await scanChanges(root, previous, {
      hash: failing,
    });
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.unchanged, ['open-in-excel.md', 'other.md']);
    assert.deepEqual(
      current.entries['open-in-excel.md'],
      previous.entries['open-in-excel.md'],
    );
    assert.deepEqual(
      errors.map((e) => e.path),
      ['open-in-excel.md'],
    );
  });

  it('does not add a new file that cannot be read', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'new.md', 'x');
    const failing: FileHasher = async () => {
      throw new Error('EACCES');
    };
    const { diff, errors } = await scanChanges(root, emptyManifest(), {
      hash: failing,
    });
    assert.deepEqual(diff.added, []);
    assert.equal(errors.length, 1);
  });

  it('keeps everything under a directory that cannot be listed', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'team/a.md', 'a');
    await putFile(root, 'team/sub/b.md', 'b');
    await putFile(root, 'teamwork/c.md', 'c');
    const previous = await baseline(root);

    const io: ScanIo = {
      ...realScanIo,
      readdir: async (directory) => {
        if (directory.endsWith('team')) {
          throw new Error('EIO');
        }
        return realScanIo.readdir(directory);
      },
    };
    const { diff, errors } = await scanChanges(root, previous, { io });
    assert.deepEqual(diff.removed, [], 'files under team/ are not deleted');
    assert.deepEqual(diff.unchanged, [
      'team/a.md',
      'team/sub/b.md',
      'teamwork/c.md',
    ]);
    assert.deepEqual(
      errors.map((e) => e.path),
      ['team'],
    );
  });

  it('refuses an empty scan when files were known, unless allowed', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'a.md', 'x');
    const previous = await baseline(root);
    await rm(join(root, 'a.md'));

    await assert.rejects(scanChanges(root, previous), /is the share mounted/);
    const { diff } = await scanChanges(root, previous, { allowEmpty: true });
    assert.deepEqual(diff.removed, ['a.md']);
  });

  it('accepts an empty directory when nothing was known', async (t) => {
    const root = await tempDir(t);
    const { diff } = await scanChanges(root, emptyManifest());
    assert.deepEqual(diff.added, []);
  });
});

describe('hashFile', () => {
  it('returns the SHA-256 of the content', async (t) => {
    const root = await tempDir(t);
    const file = await putFile(root, 'a.txt', 'abc');
    assert.equal(
      await hashFile(file),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
