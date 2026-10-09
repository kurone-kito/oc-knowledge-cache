import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRIVATE_SKILLS, PROFILE_SKILLS } from './profiles.mts';

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
