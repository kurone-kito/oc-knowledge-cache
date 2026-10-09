import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp.mts';
import { buildProfiles, type ProfileSet } from './profiles.mts';
import {
  INSTRUCTIONS_FILE,
  instructionsSource,
  linkProblems,
  readExistingTokens,
  renderSkillFile,
  writeProfiles,
} from './write.mts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const generate = async (t: Parameters<typeof tempDir>[0]) => {
  const root = await tempDir(t);
  const dataDir = join(root, 'data');
  const set = buildProfiles({
    dataDir,
    model: 'test-model:latest',
    ollamaUrl: 'http://127.0.0.1:11434',
    outDir: join(root, 'openclaw'),
    repoRoot,
    tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
  });
  return { dataDir, root, set };
};

const skillFile = (
  set: ProfileSet,
  profile: 'web' | 'knowledge',
  skill: string,
) => join(set[profile].workspace, 'skills', skill, 'SKILL.md');

describe('writeProfiles', () => {
  it("writes a config and a workspace with only that profile's skill", async (t) => {
    const { dataDir, set } = await generate(t);
    const written = await writeProfiles(set, { dataDir, repoRoot });

    for (const profile of [set.web, set.knowledge]) {
      const config = JSON.parse(await readFile(profile.configPath, 'utf8'));
      assert.deepEqual(config, JSON.parse(JSON.stringify(profile.config)));
      assert.ok(written.includes(profile.configPath));
    }
    assert.ok(existsSync(skillFile(set, 'web', 'web-research')));
    assert.ok(existsSync(skillFile(set, 'knowledge', 'knowledge-search')));
    assert.equal(existsSync(skillFile(set, 'web', 'knowledge-search')), false);
    assert.equal(
      existsSync(skillFile(set, 'knowledge', 'web-research')),
      false,
    );
  });

  it('fills the repository and data paths into the knowledge skill', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const text = await readFile(
      skillFile(set, 'knowledge', 'knowledge-search'),
      'utf8',
    );
    assert.doesNotMatch(text, /\{\{KC_/);
    assert.ok(text.includes(`"workdir": "${repoRoot.replaceAll('\\', '/')}"`));
    assert.ok(
      text.includes(`"KC_DATA_DIR": "${dataDir.replaceAll('\\', '/')}"`),
    );
  });

  it("passes the profile's Ollama server to the search", async (t) => {
    const { dataDir, root, set: local } = await generate(t);
    const remote = buildProfiles({
      dataDir,
      model: 'test-model:latest',
      ollamaUrl: 'http://gpu-box:11434',
      outDir: join(root, 'remote'),
      repoRoot,
      tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
    });
    await writeProfiles(local, { dataDir, repoRoot });
    await writeProfiles(remote, { dataDir, repoRoot });
    const read = (set: ProfileSet) =>
      readFile(skillFile(set, 'knowledge', 'knowledge-search'), 'utf8');
    assert.ok(
      (await read(local)).includes('"OLLAMA_HOST": "http://127.0.0.1:11434"'),
    );
    const remoteText = await read(remote);
    assert.ok(remoteText.includes('"OLLAMA_HOST": "http://gpu-box:11434"'));
    assert.ok(!remoteText.includes('{{KC_'));
  });

  it('keeps the web workspace free of anything about the cache', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const text = await readFile(skillFile(set, 'web', 'web-research'), 'utf8');
    assert.doesNotMatch(text, /kc:search|knowledge cache|store\.sqlite/);
    assert.ok(!text.includes(dataDir.replaceAll('\\', '/')));
  });

  it('is repeatable and removes a skill that does not belong to the profile', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });

    // A leftover from an earlier layout: the knowledge skill in the web workspace.
    const stray = skillFile(set, 'web', 'knowledge-search');
    await mkdir(join(stray, '..'), { recursive: true });
    await writeFile(stray, 'stale');
    await writeProfiles(set, { dataDir, repoRoot });

    assert.equal(existsSync(stray), false, 'the stale skill is gone');
    assert.ok(existsSync(skillFile(set, 'web', 'web-research')));
  });

  it('leaves skills it does not know untouched', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const own = join(set.web.workspace, 'skills', 'my-own-skill', 'SKILL.md');
    await mkdir(join(own, '..'), { recursive: true });
    await writeFile(own, 'mine');
    await writeProfiles(set, { dataDir, repoRoot });
    assert.equal(await readFile(own, 'utf8'), 'mine');
  });

  it('tightens the mode of a config that was left readable by others', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX file modes do not apply on Windows');
      return;
    }
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    await chmod(set.knowledge.configPath, 0o644);
    await writeProfiles(set, { dataDir, repoRoot });
    const mode = (await stat(set.knowledge.configPath)).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('never creates the state directories', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    assert.equal(existsSync(set.web.stateDir), false);
    assert.equal(existsSync(set.knowledge.stateDir), false);
  });
});

describe('writeProfiles and links', () => {
  const link = async (target: string, path: string): Promise<boolean> => {
    try {
      await symlink(
        target,
        path,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      return true;
    } catch {
      return false;
    }
  };

  it('refuses a workspace that is a link, and writes nothing anywhere', async (t) => {
    const { dataDir, root, set } = await generate(t);
    await mkdir(dataDir, { recursive: true });
    await mkdir(set.web.dir, { recursive: true });
    if (!(await link(dataDir, set.web.workspace))) {
      t.skip('links cannot be created here');
      return;
    }
    await assert.rejects(
      writeProfiles(set, { dataDir, repoRoot }),
      /is a link; refusing to write/,
    );
    assert.deepEqual(await readdir(dataDir), [], 'the cache is untouched');
    assert.equal(existsSync(set.knowledge.configPath), false);
    assert.equal(
      existsSync(join(root, 'openclaw', 'web', 'openclaw.json')),
      false,
    );
  });

  it('refuses a state folder that is a link, also one that points nowhere yet', async (t) => {
    const { dataDir, root, set } = await generate(t);
    await mkdir(set.web.dir, { recursive: true });
    if (!(await link(join(root, 'not-there-yet'), set.web.stateDir))) {
      t.skip('links to a missing target cannot be created here');
      return;
    }
    await assert.rejects(
      writeProfiles(set, { dataDir, repoRoot }),
      /is a link; refusing to write/,
    );
    assert.equal(
      existsSync(set.knowledge.configPath),
      false,
      'nothing written',
    );
  });

  it('refuses a profile folder or a config that is a link', async (t) => {
    const { dataDir, root, set } = await generate(t);
    await mkdir(dataDir, { recursive: true });
    await mkdir(join(root, 'openclaw'), { recursive: true });
    if (!(await link(dataDir, set.knowledge.dir))) {
      t.skip('links cannot be created here');
      return;
    }
    await assert.rejects(
      writeProfiles(set, { dataDir, repoRoot }),
      /is a link; refusing to write/,
    );
    assert.deepEqual(await readdir(dataDir), []);
  });
});

describe('operating instructions', () => {
  /** What OpenClaw seeds into a workspace of its own accord. */
  const SEEDED = '# AGENTS.md - Your Workspace\n';
  const instructionsOf = (set: ProfileSet, profile: 'web' | 'knowledge') =>
    join(set[profile].workspace, INSTRUCTIONS_FILE);

  it('writes the instructions of each profile from the repository', async (t) => {
    const { dataDir, set } = await generate(t);
    const written = await writeProfiles(set, { dataDir, repoRoot });
    for (const name of ['web', 'knowledge'] as const) {
      const file = instructionsOf(set, name);
      assert.ok(written.includes(file), `${name} instructions are reported`);
      assert.equal(
        await readFile(file, 'utf8'),
        await readFile(instructionsSource(repoRoot, name), 'utf8'),
      );
    }
    // No copy of anything that was not there.
    assert.equal(existsSync(`${instructionsOf(set, 'knowledge')}.bak`), false);
  });

  it('points the knowledge agent at its skill, and keeps the web agent off the cache', async () => {
    const knowledge = await readFile(
      instructionsSource(repoRoot, 'knowledge'),
      'utf8',
    );
    assert.match(knowledge, /skills\/knowledge-search\/SKILL\.md/);
    const web = await readFile(instructionsSource(repoRoot, 'web'), 'utf8');
    assert.doesNotMatch(web, /knowledge-search|kc:search/);
  });

  it('keeps what it replaces as AGENTS.md.bak, once, and only when it differs', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const file = instructionsOf(set, 'knowledge');
    const generated = await readFile(file, 'utf8');

    // Generating again over an identical file makes no copy.
    await writeProfiles(set, { dataDir, repoRoot });
    assert.equal(existsSync(`${file}.bak`), false);

    // OpenClaw's template, or a hand edit, is replaced and kept.
    await writeFile(file, SEEDED);
    await writeProfiles(set, { dataDir, repoRoot });
    assert.equal(await readFile(file, 'utf8'), generated);
    assert.equal(await readFile(`${file}.bak`, 'utf8'), SEEDED);

    // Identical again: the copy stays as it was.
    await writeProfiles(set, { dataDir, repoRoot });
    assert.equal(await readFile(`${file}.bak`, 'utf8'), SEEDED);
  });

  it('refuses a link in the place of the instructions, and writes nothing through it', async (t) => {
    const { dataDir, root, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const file = instructionsOf(set, 'knowledge');
    const elsewhere = join(root, 'elsewhere.md');
    await writeFile(elsewhere, 'untouched');
    await rm(file);
    try {
      await symlink(elsewhere, file, 'file');
    } catch {
      t.skip('file links cannot be created here');
      return;
    }
    await assert.rejects(
      writeProfiles(set, { dataDir, repoRoot }),
      /is a link; refusing to write/,
    );
    assert.equal(await readFile(elsewhere, 'utf8'), 'untouched');
    assert.ok(
      (await linkProblems(set.knowledge)).some((p) => p.startsWith(file)),
    );
  });

  it('refuses a link in the place of the copy before anything is written', async (t) => {
    const { dataDir, root, set } = await generate(t);
    const copy = `${instructionsOf(set, 'knowledge')}.bak`;
    const elsewhere = join(root, 'elsewhere.md');
    await writeFile(elsewhere, 'untouched');
    await mkdir(set.knowledge.workspace, { recursive: true });
    try {
      await symlink(elsewhere, copy, 'file');
    } catch {
      t.skip('file links cannot be created here');
      return;
    }
    await assert.rejects(
      writeProfiles(set, { dataDir, repoRoot }),
      /is a link; refusing to write/,
    );
    assert.equal(await readFile(elsewhere, 'utf8'), 'untouched');
    // Nothing of either profile exists: the refusal came before the writing.
    assert.equal(existsSync(set.web.workspace), false);
    assert.equal(existsSync(instructionsOf(set, 'knowledge')), false);
    assert.equal(existsSync(set.knowledge.configPath), false);
  });

  it('refuses a folder where the instructions or their copy belong, before anything is written', async (t) => {
    for (const suffix of ['', '.bak']) {
      const { dataDir, set } = await generate(t);
      await mkdir(`${instructionsOf(set, 'knowledge')}${suffix}`, {
        recursive: true,
      });
      await assert.rejects(
        writeProfiles(set, { dataDir, repoRoot }),
        /is a folder where a file belongs/,
      );
      assert.equal(existsSync(set.web.workspace), false, suffix);
      assert.equal(existsSync(set.knowledge.configPath), false, suffix);
      assert.equal(
        existsSync(join(set.knowledge.workspace, 'skills')),
        false,
        suffix,
      );
    }
  });
});

describe('hard links', () => {
  it('refuses a skill file that has another name, and leaves the other name alone', async (t) => {
    const { dataDir, root, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const skill = skillFile(set, 'knowledge', 'knowledge-search');
    const other = join(root, 'other-name.md');
    try {
      await link(skill, other);
    } catch {
      t.skip('hard links cannot be created here');
      return;
    }
    await assert.rejects(
      writeProfiles(set, { dataDir, repoRoot }),
      /more than one name/,
    );
    assert.equal(await readFile(other, 'utf8'), await readFile(skill, 'utf8'));
    assert.deepEqual(
      (await linkProblems(set.knowledge)).map((p) =>
        /more than one name/.test(p),
      ),
      [true],
    );
  });
});

describe('renderSkillFile in one pass', () => {
  it('does not substitute again inside a value that looks like a placeholder', () => {
    const rendered = renderSkillFile(
      'workdir {{KC_REPO}} data {{KC_DATA}} host {{KC_OLLAMA}}',
      { dataDir: '/srv/data', repoRoot: '/tmp/{{KC_DATA}}' },
      'http://{{KC_REPO}}:11434',
    );
    assert.equal(
      rendered,
      'workdir /tmp/{{KC_DATA}} data /srv/data host http://{{KC_REPO}}:11434',
    );
  });
});

describe('renderSkillFile', () => {
  it('keeps a path with quotes valid inside the JSON of the skill', () => {
    const text =
      '{ "KC_DATA_DIR": "{{KC_DATA}}", "OLLAMA_HOST": "{{KC_OLLAMA}}" }';
    const rendered = renderSkillFile(
      text,
      { dataDir: '/srv/"quoted" $& $$', repoRoot: '/srv/kc' },
      'http://host:11434',
    );
    assert.deepEqual(JSON.parse(rendered), {
      KC_DATA_DIR: '/srv/"quoted" $& $$',
      OLLAMA_HOST: 'http://host:11434',
    });
    // A repository path with a backtick, a quote or a line break stays one
    // JSON string, and so cannot add text to the instructions.
    const hostile = renderSkillFile(
      '{ "workdir": "{{KC_REPO}}" }',
      { dataDir: '/d', repoRoot: '/srv/`evil`\n"x"' },
      'http://host:11434',
    );
    assert.deepEqual(JSON.parse(hostile), { workdir: '/srv/`evil`\n"x"' });
    // A run of backticks cannot close the fence that holds the block.
    const fenced = renderSkillFile(
      '```json\n{ "workdir": "{{KC_REPO}}" }\n```',
      { dataDir: '/d', repoRoot: '/tmp/```marker```/data' },
      'http://host:11434',
    );
    assert.equal(fenced.split('```').length, 3, 'only the two fences remain');
    const body = fenced.slice('```json\n'.length, fenced.lastIndexOf('\n```'));
    assert.deepEqual(JSON.parse(body), { workdir: '/tmp/```marker```/data' });
  });
});

describe('skill placeholders', () => {
  it('writes paths with replacement patterns and quotes literally', async (t) => {
    const root = await tempDir(t);
    const dataDir = join(root, 'data $& and $$');
    const set = buildProfiles({
      dataDir,
      model: 'm',
      ollamaUrl: 'http://127.0.0.1:11434',
      outDir: join(root, 'openclaw'),
      repoRoot,
      tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
    });
    await writeProfiles(set, { dataDir, repoRoot });
    const text = await readFile(
      skillFile(set, 'knowledge', 'knowledge-search'),
      'utf8',
    );
    assert.ok(!text.includes('{{KC_'), 'no placeholder is left');
    // The env block is the JSON between the fences, and it must parse.
    const start = text.indexOf('```json\n') + '```json\n'.length;
    const end = text.indexOf('```', start);
    const parsed = JSON.parse(text.slice(start, end));
    assert.equal(
      parsed.env.KC_DATA_DIR,
      dataDir.replaceAll('\\', '/'),
      'the env block is valid JSON with the exact path',
    );
  });
});

describe('special files', () => {
  it('refuses a pipe in the place of a generated file', async (t) => {
    if (process.platform === 'win32') {
      t.skip('named pipes are made differently on Windows');
      return;
    }
    const { dataDir, set } = await generate(t);
    await mkdir(set.web.dir, { recursive: true });
    try {
      execFileSync('mkfifo', [set.web.configPath]);
    } catch {
      t.skip('mkfifo is not available here');
      return;
    }
    await assert.rejects(
      writeProfiles(set, { dataDir, repoRoot }),
      /not a regular file or folder/,
    );
    assert.equal(
      existsSync(set.knowledge.configPath),
      false,
      'nothing written',
    );
  });
});

describe('stale skill files', () => {
  it('removes a plain file in the place of a skill the profile must not have', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const stale = join(set.web.workspace, 'skills', 'knowledge-search');
    await rm(stale, { force: true, recursive: true });
    await writeFile(stale, 'not a folder');
    await writeProfiles(set, { dataDir, repoRoot });
    assert.equal(existsSync(stale), false);
    assert.ok(existsSync(skillFile(set, 'web', 'web-research')));
  });
});

describe('stale skill links', () => {
  it('removes a link in the place of a skill the profile must not have', async (t) => {
    const { dataDir, root, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const target = join(root, 'precious');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'keep');
    const stale = join(set.web.workspace, 'skills', 'knowledge-search');
    try {
      await symlink(
        target,
        stale,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      t.skip('links cannot be created here');
      return;
    }
    await writeProfiles(set, { dataDir, repoRoot });
    assert.equal(existsSync(stale), false, 'the link is gone');
    assert.equal(
      existsSync(join(target, 'keep.txt')),
      true,
      'its target stays',
    );
  });
});

describe('a link or a file in the place of the backup or a folder', () => {
  it('does not follow a link at the backup when it tightens the mode', async (t) => {
    if (process.platform === 'win32') {
      t.skip('POSIX modes do not apply on Windows');
      return;
    }
    const { dataDir, root, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const target = join(root, 'elsewhere.txt');
    await writeFile(target, 'not ours');
    await chmod(target, 0o644);
    await symlink(target, `${set.web.configPath}.bak`, 'file');
    await assert.rejects(
      writeProfiles(set, { dataDir, repoRoot }),
      /is a link; refusing/,
    );
    assert.equal((await stat(target)).mode & 0o777, 0o644);
  });

  it('names a plain file where a folder belongs, without stumbling over what is below it', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const skills = join(set.web.workspace, 'skills');
    await rm(skills, { recursive: true });
    await writeFile(skills, 'not a folder');
    // Only the file itself: what would lie below it (ENOTDIR) is not a
    // second problem.
    assert.deepEqual(
      (await linkProblems(set.web)).map((p) =>
        p.startsWith(`${skills} is a file where a folder belongs`),
      ),
      [true],
    );
    await assert.rejects(
      writeProfiles(set, { dataDir, repoRoot }),
      /is a file where a folder belongs/,
    );
  });

  it('names a plain file in the place of the workspace', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    await rm(set.web.workspace, { recursive: true });
    await writeFile(set.web.workspace, 'not a folder');
    assert.deepEqual(
      (await linkProblems(set.web)).map((p) =>
        p.startsWith(`${set.web.workspace} is a file where a folder belongs`),
      ),
      [true],
    );
  });
});

describe('replacing a config', () => {
  it('keeps the previous config, with what a person added, as openclaw.json.bak', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    assert.equal(
      existsSync(`${set.web.configPath}.bak`),
      false,
      'a first write has nothing to keep',
    );

    const edited = JSON.parse(await readFile(set.web.configPath, 'utf8'));
    edited.ui = { theme: 'dark' };
    await writeFile(set.web.configPath, JSON.stringify(edited));
    await writeProfiles(set, { dataDir, repoRoot });

    const saved = JSON.parse(
      await readFile(`${set.web.configPath}.bak`, 'utf8'),
    );
    assert.deepEqual(saved.ui, { theme: 'dark' });
    const fresh = JSON.parse(await readFile(set.web.configPath, 'utf8'));
    assert.equal(fresh.ui, undefined, 'the new config is the generated one');

    // A second edit replaces the backup as well: regenerating is repeatable.
    const again = JSON.parse(await readFile(set.web.configPath, 'utf8'));
    again.ui = { theme: 'light' };
    await writeFile(set.web.configPath, JSON.stringify(again));
    await writeProfiles(set, { dataDir, repoRoot });
    const secondBackup = JSON.parse(
      await readFile(`${set.web.configPath}.bak`, 'utf8'),
    );
    assert.deepEqual(secondBackup.ui, { theme: 'light' });

    // An older backup that others can read is tightened, whatever else happens.
    if (process.platform !== 'win32') {
      await chmod(`${set.web.configPath}.bak`, 0o644);
      await writeProfiles(set, { dataDir, repoRoot });
      const mode = (await stat(`${set.web.configPath}.bak`)).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    // An unchanged config is not copied again.
    await writeFile(`${set.web.configPath}.bak`, 'marker');
    await writeProfiles(set, { dataDir, repoRoot });
    assert.equal(await readFile(`${set.web.configPath}.bak`, 'utf8'), 'marker');
  });
});

describe('writing the config', () => {
  it('leaves no temporary file behind and replaces the old config whole', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    await writeFile(set.web.configPath, '{ "half": ');
    await writeProfiles(set, { dataDir, repoRoot });
    assert.deepEqual(
      JSON.parse(await readFile(set.web.configPath, 'utf8')),
      JSON.parse(JSON.stringify(set.web.config)),
    );
    assert.deepEqual(
      (await readdir(set.web.dir)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });
});

describe('readExistingTokens', () => {
  it('keeps only one of two profiles that share a token', async (t) => {
    const { dataDir, set } = await generate(t);
    await writeProfiles(set, { dataDir, repoRoot });
    const config = JSON.parse(await readFile(set.knowledge.configPath, 'utf8'));
    config.gateway.auth.token = 'w'.repeat(24);
    await writeFile(set.knowledge.configPath, JSON.stringify(config));
    assert.deepEqual(await readExistingTokens(set), { web: 'w'.repeat(24) });
  });

  it('returns the tokens of an earlier run and ignores what it cannot read', async (t) => {
    const { dataDir, set } = await generate(t);
    assert.deepEqual(await readExistingTokens(set), {});

    await writeProfiles(set, { dataDir, repoRoot });
    assert.deepEqual(await readExistingTokens(set), {
      knowledge: 'k'.repeat(24),
      web: 'w'.repeat(24),
    });

    await writeFile(set.web.configPath, '{ broken');
    assert.deepEqual(await readExistingTokens(set), {
      knowledge: 'k'.repeat(24),
    });
  });
});
