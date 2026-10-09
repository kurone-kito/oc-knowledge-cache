import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { convertWorkbookFile } from '../excel/convert.mts';
import { tempDir } from '../shared/temp.mts';
import {
  ALLOWED_SENDER,
  buildReviewFixtures,
  OTHER_SENDER,
  type ReviewFixtures,
} from './review-flow.mts';

/**
 * Runs git. `safe.bareRepository=all` lets it work inside the bare server even
 * on a machine whose own configuration says `explicit`.
 */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'safe.bareRepository=all', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: 'pipe',
  }).trim();

/** The header block and the body of a mail, with the headers by name. */
const parseMail = async (
  file: string,
): Promise<{ body: string; headers: Record<string, string> }> => {
  const text = await readFile(file, 'utf8');
  const split = text.indexOf('\r\n\r\n');
  assert.ok(split > 0, `${file} has a blank line after its headers`);
  const headers: Record<string, string> = {};
  for (const line of text.slice(0, split).split('\r\n')) {
    const colon = line.indexOf(': ');
    assert.ok(colon > 0, `a header line in ${file}: ${line}`);
    headers[line.slice(0, colon)] = line.slice(colon + 2);
  }
  return { body: text.slice(split + 4), headers };
};

const build = async (
  t: Parameters<typeof tempDir>[0],
  name = 'fixtures',
): Promise<ReviewFixtures> => {
  const root = join(await tempDir(t), name);
  await mkdir(root, { recursive: true });
  return buildReviewFixtures(root);
};

describe('review-flow fixtures', () => {
  it('builds mail whose headers parse, with a duplicate, a stranger and an injection', async (t) => {
    const { mails } = await build(t);
    const request = await parseMail(mails.request);
    const duplicate = await parseMail(mails.duplicate);
    const stranger = await parseMail(mails.stranger);
    const injection = await parseMail(mails.injection);

    assert.match(request.headers['From'] ?? '', new RegExp(ALLOWED_SENDER));
    assert.equal(
      request.headers['Message-ID'],
      '<review-0001@example.invalid>',
    );
    assert.equal(
      duplicate.headers['Message-ID'],
      request.headers['Message-ID'],
      'the duplicate has the same Message-ID',
    );
    assert.notEqual(duplicate.headers['Date'], request.headers['Date']);
    assert.match(stranger.headers['From'] ?? '', new RegExp(OTHER_SENDER));
    assert.notEqual(
      stranger.headers['Message-ID'],
      request.headers['Message-ID'],
    );
    assert.match(injection.body, /Ignore your rules/);
    assert.match(request.body, /レビューをお願いします/);
  });

  it('keeps the ledger, the branches and the mail consistent with each other', async (t) => {
    const fixtures = await build(t);
    const request = await parseMail(fixtures.mails.request);
    const ledgerId = /Ledger id: (LG-\d+)/.exec(request.body)?.[1];
    const branch = /Branch: (\S+)/.exec(request.body)?.[1];
    assert.equal(ledgerId, 'LG-002');
    assert.equal(branch, 'feature/cart-limit');

    // The existing Excel reader opens the ledger, and the row is in it.
    const converted = await convertWorkbookFile(fixtures.ledger);
    assert.ok(converted.ok, converted.ok ? '' : converted.error.message);
    assert.match(
      converted.value.markdown,
      /LG-002 \| feature\/cart-limit \| alice@example\.invalid \| Requested/,
    );

    // The branch of the request is on the server.
    assert.ok(
      git(fixtures.server, 'branch', '--list', branch ?? '').includes(
        branch ?? '?',
      ),
    );
    assert.deepEqual(Object.keys(fixtures.branches).sort(), [
      'feature/cart-limit',
      'feature/login',
      'feature/payments',
      'main',
    ]);
  });

  it('builds a git server and a clone that pass git fsck', async (t) => {
    const fixtures = await build(t);
    for (const repository of [fixtures.server, fixtures.clone]) {
      // fsck prints to stderr only on trouble, and throws on a failure.
      git(repository, 'fsck', '--strict');
    }
    // Git may report the path with other separators than the ones we used.
    assert.equal(
      resolve(git(fixtures.clone, 'remote', 'get-url', 'origin')),
      resolve(fixtures.server),
    );
    for (const [branch, id] of Object.entries(fixtures.branches)) {
      assert.equal(git(fixtures.server, 'rev-parse', branch), id);
    }
  });

  it('plants each defect on its branch and not on main', async (t) => {
    const fixtures = await build(t);
    assert.ok(fixtures.defects.length >= 3);
    assert.deepEqual(
      [...new Set(fixtures.defects.map((defect) => defect.kind))].sort(),
      ['credential', 'design-deviation', 'unchecked-input'],
    );
    for (const defect of fixtures.defects) {
      const onBranch = git(
        fixtures.server,
        'show',
        `${defect.branch}:${defect.file}`,
      );
      assert.ok(onBranch.includes(defect.marker), `${defect.kind} is planted`);
      let onMain = '';
      try {
        onMain = git(fixtures.server, 'show', `main:${defect.file}`);
      } catch {
        // The file does not exist on main at all.
      }
      assert.ok(
        !onMain.includes(defect.marker),
        `${defect.kind} is not on main`,
      );
    }
    // The payments branch is the clean one.
    assert.equal(
      fixtures.defects.some((defect) => defect.branch === 'feature/payments'),
      false,
    );
  });

  it('gives the same mail, ledger values and commit ids on every build', async (t) => {
    const first = await build(t, 'a');
    const second = await build(t, 'b');
    for (const name of [
      'request',
      'duplicate',
      'stranger',
      'injection',
    ] as const) {
      assert.equal(
        await readFile(first.mails[name], 'utf8'),
        await readFile(second.mails[name], 'utf8'),
        name,
      );
    }
    assert.deepEqual(first.branches, second.branches);
    const [one, two] = await Promise.all([
      convertWorkbookFile(first.ledger),
      convertWorkbookFile(second.ledger),
    ]);
    assert.ok(one.ok && two.ok);
    assert.equal(one.value.markdown, two.value.markdown);
  });
});
