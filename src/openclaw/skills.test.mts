import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CACHE_SKILLS, PRIVATE_SKILLS, PROFILE_SKILLS } from './profiles.mts';

const skillsRoot = fileURLToPath(
  new URL('../../openclaw/skills', import.meta.url),
);

const read = (skill: string): Promise<string> =>
  readFile(join(skillsRoot, skill, 'SKILL.md'), 'utf8');

/** The `key: value` lines of the YAML frontmatter, enough for these skills. */
const frontmatter = (text: string): Record<string, string> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(match?.[1], 'the file starts with YAML frontmatter');
  return Object.fromEntries(
    match[1].split(/\r?\n/).map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
};

describe('OpenClaw skills', async () => {
  const skills = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('are exactly the ones that a profile declares', () => {
    const declared = [
      ...new Set([...PROFILE_SKILLS.knowledge, ...PROFILE_SKILLS.web]),
    ].sort();
    assert.deepEqual(
      skills,
      declared,
      'a skill folder with no declaration is never installed; a declaration with no folder cannot be installed',
    );
  });

  it('keep every private skill out of the web profile', () => {
    for (const skill of PRIVATE_SKILLS) {
      assert.ok(
        PROFILE_SKILLS.knowledge.includes(skill),
        `${skill} is declared for knowledge`,
      );
      assert.ok(
        !PROFILE_SKILLS.web.includes(skill),
        `${skill} is not declared for web`,
      );
    }
  });

  it('list as cache skills exactly those that carry the settings of the cache', async () => {
    for (const skill of skills) {
      assert.equal(
        /\{\{KC_(REPO|DATA|OLLAMA)\}\}/.test(await read(skill)),
        CACHE_SKILLS.includes(skill),
        `${skill}: placeholders of the cache and CACHE_SKILLS agree`,
      );
    }
  });

  it('request-triage names the three outcomes, the four factors and the answer form', async () => {
    const text = await read('request-triage');
    for (const needle of [
      'Do it now',
      'Compose',
      'New capability',
      'Reuse',
      'New input or output',
      'Permissions',
      'Testing',
      'Outcome:',
      'Estimate:',
      'Next step:',
    ]) {
      assert.ok(text.includes(needle), `mentions ${needle}`);
    }
  });

  it('request-triage keeps the request in the session and builds and publishes nothing', async () => {
    const text = await read('request-triage');
    assert.match(text, /Never send the request/);
    assert.match(text, /Do not publish an issue/);
    assert.doesNotMatch(text, /`(gh|curl|git push)\b/);
  });

  it('request-triage lists the issue-draft skill among what exists and leaves the publishing to a person', async () => {
    const text = (await read('request-triage')).replace(/\s+/g, ' ');
    const exists = text.slice(
      text.indexOf('## What exists now'),
      text.indexOf('## The estimate'),
    );
    assert.match(exists, /`issue-draft`/);
    assert.match(exists, /publishes nothing/);
    // The estimate no longer says that a person writes the issue.
    assert.doesNotMatch(text, /that a person writes and publishes/);
    assert.match(text, /a person reviews it and publishes it/);
  });

  it('issue-draft writes a local draft for a person to read and publishes nothing', async () => {
    // Lines are wrapped: compare with the whitespace collapsed.
    const text = (await read('issue-draft')).replace(/\s+/g, ' ');
    assert.match(text, /You do \*\*not\*\* publish it/);
    assert.match(text, /until a person has read it/);
    assert.match(
      text,
      /DRAFT - not reviewed - do not publish before a person has read it/,
    );
    // The destination is a full path in the workspace, filled in when the
    // profile is generated: the working directory can be the project repository.
    assert.match(text, /"drafts": "\{\{KC_WORKSPACE\}\}\/drafts"/);
    assert.match(text, /never into the project repository or the cache/);
    assert.match(text, /never a relative path/);
    // The commands that send text out are named only to forbid them.
    const never = text.slice(
      text.indexOf('## Never'),
      text.indexOf('## Steps'),
    );
    assert.match(never, /`gh`/);
    // Not only publishing: no network request of any kind.
    assert.match(never, /network request of any kind/);
    assert.doesNotMatch(
      text.replace(never, ''),
      /`(gh|curl|git push|sendmail|mail)\b/,
    );
  });

  it('issue-draft asks for the generic capability first and a private note of what was left out', async () => {
    const text = await read('issue-draft');
    assert.match(text, /Generalize first/);
    assert.match(text, /\.private\.md/);
    // The person is told that the scrubbing can fail (it did, in the runs).
    assert.match(
      text.replace(/\s+/g, ' '),
      /read against their original request/,
    );
    for (const section of [
      '## Goal',
      '## Scope',
      '## Acceptance criteria',
      '## Test strategy',
      '## Estimate',
      '## Abstraction check',
    ]) {
      assert.ok(text.includes(section), `the template has ${section}`);
    }
  });

  it('issue-draft has an optional Part of line that takes a public issue only, and one rule on language', async () => {
    const text = (await read('issue-draft')).replace(/\s+/g, ' ');
    assert.match(text, /Part of <a public issue of this project/);
    assert.match(text, /takes only a public issue of this project/);
    // The ban on figures leaves room for that one number.
    const never = text.slice(
      text.indexOf('## Never'),
      text.indexOf('## Steps'),
    );
    assert.match(never, /no real figures/);
    assert.match(never, /public issue of the `Part of` line/);
    assert.doesNotMatch(never, /no real numbers/);
    // One rule on the language, with the same exception in the template and in
    // the boundaries.
    assert.match(
      text,
      /in English unless the person asks for another language/,
    );
    assert.match(text, /in English unless they ask for another language/);
    assert.doesNotMatch(text, /the draft itself is in English\./);
  });

  for (const skill of skills) {
    it(`${skill} has a name equal to its folder and a useful description`, async () => {
      const meta = frontmatter(await read(skill));
      assert.equal(meta['name'], skill);
      assert.ok(
        (meta['description'] ?? '').length >= 40,
        'describes when to use it',
      );
    });
  }

  it('knowledge-search runs the search script with the placeholders and cites sources', async () => {
    const text = await read('knowledge-search');
    assert.ok(
      text.includes(
        'pnpm run --silent kc:search --json --k 5 --question-env KC_QUESTION',
      ),
    );
    assert.ok(text.includes('"workdir": "{{KC_REPO}}"'));
    assert.ok(text.includes('"KC_DATA_DIR": "{{KC_DATA}}"'));
    assert.ok(text.includes('"OLLAMA_HOST": "{{KC_OLLAMA}}"'));
    assert.match(text, /never in the command/);
    // No fallback that would put the question on a command line.
    assert.match(text, /Never put the question on the command line/);
    assert.doesNotMatch(text, /single quotes|'\\''/);
    assert.match(text, /cite/i);
    assert.match(text, /do\s+not\s+invent/i);
    assert.deepEqual(
      JSON.parse(frontmatter(text)['metadata'] ?? '{}').openclaw.requires.bins,
      ['pnpm'],
    );
  });

  it('web-research never mentions the cache, the data directory or the NAS', async () => {
    const text = await read('web-research');
    assert.doesNotMatch(
      text,
      /kc:search|store\.sqlite|\{\{KC_|knowledge cache|\.data/i,
    );
    assert.match(text, /untrusted/i);
  });
});
