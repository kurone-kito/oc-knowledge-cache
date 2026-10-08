import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { putFile, tempDir } from '../shared/temp.mts';
import { realScanIo, type ScanIo, scanSource } from './scan.mts';

const paths = (result: { files: ReadonlyArray<{ path: string }> }): string[] =>
  result.files.map((file) => file.path);

describe('scanSource', () => {
  it('lists supported files recursively with POSIX relative paths, sorted', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'b/design.xlsx', 'x');
    await putFile(root, 'a/deep/er/spec.md', 'x');
    await putFile(root, 'a/notes.TXT', 'x');
    await putFile(root, 'top.xlsm', 'x');
    await putFile(root, 'image.png', 'x');
    await putFile(root, 'legacy.xls', 'x');

    const result = await scanSource(root);

    assert.deepEqual(paths(result), [
      'a/deep/er/spec.md',
      'a/notes.TXT',
      'b/design.xlsx',
      'top.xlsm',
    ]);
    assert.deepEqual(result.errors, []);
  });

  it('reports size and modification time', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'a.md', 'hello', 1_700_000_123);
    const [file] = (await scanSource(root)).files;
    assert.equal(file?.size, 5);
    assert.equal(file?.mtimeMs, 1_700_000_123_000);
  });

  it('skips Office lock files, temp files and NAS housekeeping folders', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'keep.xlsx', 'x');
    await putFile(root, '~$keep.xlsx', 'x');
    await putFile(root, 'sub/.~lock.keep.md#', 'x');
    await putFile(root, 'sub/draft.tmp', 'x');
    await putFile(root, '@eaDir/keep.xlsx/thumb.xlsx', 'x');
    await putFile(root, 'sub/#recycle/old.xlsx', 'x');
    await putFile(root, '.git/config.md', 'x');

    assert.deepEqual(paths(await scanSource(root)), ['keep.xlsx']);
  });

  it('skips a directory that an exclude names directly', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'keep.md', 'x');
    await putFile(root, 'private/secret.md', 'x');
    await putFile(root, 'team/private/secret.md', 'x');
    await putFile(root, 'team/open.md', 'x');

    assert.deepEqual(
      paths(await scanSource(root, { exclude: ['private'] })),
      ['keep.md', 'team/open.md', 'team/private/secret.md'],
      'a bare name matches only at the top',
    );
    assert.deepEqual(
      paths(await scanSource(root, { exclude: ['**/private'] })),
      ['keep.md', 'team/open.md'],
    );
  });

  it('honors extra excludes and a custom extension list', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'a.xlsx', 'x');
    await putFile(root, 'old/b.xlsx', 'x');
    await putFile(root, 'c.md', 'x');

    const result = await scanSource(root, {
      exclude: ['old/**'],
      extensions: ['.xlsx'],
    });
    assert.deepEqual(paths(result), ['a.xlsx']);
  });

  it('matches extensions and exclude patterns case-insensitively', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'Design.XLSX', 'x');
    await putFile(root, 'Archive/Old.xlsx', 'x');
    const result = await scanSource(root, { exclude: ['archive/**'] });
    assert.deepEqual(paths(result), ['Design.XLSX']);
  });

  it('throws when the root cannot be read', async (t) => {
    const root = await tempDir(t);
    await assert.rejects(
      scanSource(`${root}/does-not-exist`),
      /Cannot read source directory/,
    );
  });

  it('records unreadable directories and files, then keeps going', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'ok.md', 'x');
    await putFile(root, 'locked/inside.md', 'x');
    await putFile(root, 'busy.md', 'x');

    const io: ScanIo = {
      readdir: async (directory) => {
        if (directory.endsWith('locked')) {
          throw new Error('EACCES: permission denied');
        }
        return realScanIo.readdir(directory);
      },
      stat: async (file) => {
        if (file.endsWith('busy.md')) {
          throw new Error('EBUSY: resource busy');
        }
        return realScanIo.stat(file);
      },
    };

    const result = await scanSource(root, {}, io);
    assert.deepEqual(paths(result), ['ok.md']);
    assert.deepEqual(
      result.errors.map((e) => [e.kind, e.path]),
      [
        ['file', 'busy.md'],
        ['directory', 'locked'],
      ],
    );
  });

  it('does not follow symbolic links', async (t) => {
    const root = await tempDir(t);
    await putFile(root, 'real/a.md', 'x');
    const { symlink } = await import('node:fs/promises');
    try {
      await symlink(`${root}/real`, `${root}/link`, 'dir');
    } catch {
      t.skip('symbolic links are not permitted here');
      return;
    }
    assert.deepEqual(paths(await scanSource(root)), ['real/a.md']);
  });
});
