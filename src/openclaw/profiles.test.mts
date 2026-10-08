import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildProfiles,
  CONTROL_PLANE_TOOLS,
  checkProfiles,
  DEFAULT_CONTEXT_WINDOW,
  isInside,
  MIN_PORT_SPACING,
  type OpenClawProfile,
  type ProfileInput,
  type ProfileSet,
  posix,
} from './profiles.mts';

/** Absolute POSIX-style form of a path, whatever the platform. */
const abs = (path: string): string => resolve(path).replaceAll('\\', '/');

const input = (extra: Partial<ProfileInput> = {}): ProfileInput => ({
  dataDir: '/srv/kc/.data',
  model: 'qwen3.6:35b-a3b-coding',
  ollamaUrl: 'http://127.0.0.1:11434',
  outDir: '/srv/kc/.openclaw',
  projectRepo: '/work/project',
  repoRoot: '/srv/kc',
  tokens: { knowledge: 'k'.repeat(24), web: 'w'.repeat(24) },
  ...extra,
});

const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (current, key) => (current as Record<string, unknown> | undefined)?.[key],
    value,
  );

const strings = (value: unknown): string[] => value as string[];

/** Returns a set whose profile config is edited by `edit`. */
const tampered = (
  set: ProfileSet,
  which: 'web' | 'knowledge',
  edit: (config: Record<string, unknown>) => void,
): ProfileSet => {
  const copy = structuredClone(set[which]) as OpenClawProfile;
  edit(copy.config);
  return { ...set, [which]: copy };
};

describe('buildProfiles', () => {
  it('builds two profiles that share nothing', () => {
    const { web, knowledge } = buildProfiles(input());
    assert.notEqual(web.configPath, knowledge.configPath);
    assert.notEqual(web.stateDir, knowledge.stateDir);
    assert.notEqual(web.workspace, knowledge.workspace);
    assert.notEqual(web.port, knowledge.port);
    assert.ok(Math.abs(web.port - knowledge.port) >= MIN_PORT_SPACING);
    assert.equal(web.configPath, abs('/srv/kc/.openclaw/web/openclaw.json'));
    assert.equal(knowledge.stateDir, abs('/srv/kc/.openclaw/knowledge/state'));
  });

  it('points both agents at Ollama through the native URL and the same model', () => {
    for (const profile of Object.values(buildProfiles(input()))) {
      const ollama = at(profile.config, 'models', 'providers', 'ollama');
      assert.equal(at(ollama, 'baseUrl'), 'http://127.0.0.1:11434');
      assert.equal(at(ollama, 'api'), 'ollama');
      assert.equal(
        at(profile.config, 'agents', 'defaults', 'model', 'primary'),
        'ollama/qwen3.6:35b-a3b-coding',
      );
      assert.equal(
        (at(ollama, 'models') as { contextWindow: number }[])[0]?.contextWindow,
        DEFAULT_CONTEXT_WINDOW,
      );
    }
    const custom = buildProfiles(input({ contextWindow: 32768 }));
    assert.equal(
      (
        at(custom.web.config, 'models', 'providers', 'ollama', 'models') as {
          contextWindow: number;
        }[]
      )[0]?.contextWindow,
      32768,
    );
  });

  it('binds each gateway to loopback with its own token and denies the control plane', () => {
    const { web, knowledge } = buildProfiles(input());
    assert.equal(at(web.config, 'gateway', 'auth', 'token'), 'w'.repeat(24));
    assert.equal(
      at(knowledge.config, 'gateway', 'auth', 'token'),
      'k'.repeat(24),
    );
    for (const profile of [web, knowledge]) {
      assert.equal(at(profile.config, 'gateway', 'bind'), 'loopback');
      assert.equal(at(profile.config, 'gateway', 'mode'), 'local');
      const entry = (
        at(profile.config, 'models', 'providers', 'ollama', 'models') as {
          contextTokens: number;
          contextWindow: number;
          params: { num_ctx: number };
        }[]
      )[0];
      // Ollama is asked for the context, not left to its own small default.
      assert.equal(entry?.params.num_ctx, entry?.contextWindow);
      assert.equal(entry?.contextTokens, entry?.contextWindow);
      assert.equal(at(profile.config, 'gateway', 'auth', 'mode'), 'token');
      const deny = strings(at(profile.config, 'tools', 'deny'));
      for (const tool of [...CONTROL_PLANE_TOOLS, 'browser']) {
        assert.ok(deny.includes(tool), `${profile.name} denies ${tool}`);
      }
      assert.equal(at(profile.config, 'browser', 'enabled'), false);
      // Exec outside the sandbox is off for both, whatever the agents do.
      assert.equal(at(profile.config, 'tools', 'elevated', 'enabled'), false);
    }
    // The knowledge instance has no web at all, not only for its agent; the
    // web instance keeps the web tools it exists for.
    assert.ok(
      strings(at(knowledge.config, 'tools', 'deny')).includes('group:web'),
    );
    assert.ok(!strings(at(web.config, 'tools', 'deny')).includes('group:web'));
  });

  it('gives the web profile web tools, no shell, no writes and only its own skill', () => {
    const { web } = buildProfiles(input());
    const agent = at(web.config, 'agents', 'entries', 'research');
    assert.deepEqual(at(agent, 'skills'), ['web-research']);
    assert.ok(strings(at(agent, 'tools', 'alsoAllow')).includes('group:web'));
    for (const denied of [
      'group:runtime',
      'write',
      'edit',
      'apply_patch',
      'group:sessions',
    ]) {
      assert.ok(strings(at(agent, 'tools', 'deny')).includes(denied), denied);
    }
    assert.equal(at(web.config, 'tools', 'fs', 'workspaceOnly'), true);
    assert.equal(at(agent, 'cwd'), undefined, 'it never works in the project');
    assert.deepEqual(web.skills, ['web-research']);
  });

  it('gives the knowledge profile coding tools and the cache skill, but no web', () => {
    const { knowledge } = buildProfiles(input());
    const agent = at(knowledge.config, 'agents', 'entries', 'knowledge');
    assert.deepEqual(at(agent, 'skills'), ['knowledge-search']);
    assert.equal(at(agent, 'tools', 'profile'), 'coding');
    for (const denied of [
      'group:web',
      'group:ui',
      'group:automation',
      'group:sessions',
    ]) {
      assert.ok(strings(at(agent, 'tools', 'deny')).includes(denied), denied);
    }
    assert.equal(at(agent, 'cwd'), abs('/work/project'));
    assert.deepEqual(knowledge.skills, ['knowledge-search']);
  });

  it('works in its own workspace when no project repository is given', () => {
    const { knowledge } = buildProfiles(input({ projectRepo: undefined }));
    assert.equal(
      at(knowledge.config, 'agents', 'entries', 'knowledge', 'cwd'),
      undefined,
    );
  });

  it('normalizes Windows paths to forward slashes', {
    skip:
      process.platform !== 'win32' &&
      'a backslash is an ordinary character outside Windows',
  }, () => {
    const { knowledge } = buildProfiles(
      input({
        dataDir: 'C:\\kc\\.data',
        outDir: 'C:\\kc\\.openclaw',
        projectRepo: 'D:\\work\\project',
        repoRoot: 'C:\\kc',
      }),
    );
    assert.ok(!knowledge.configPath.includes('\\'));
    assert.ok(!JSON.stringify(knowledge.config).includes('\\\\'));
  });

  it('refuses ports that are too close or unusable', () => {
    assert.throws(
      () => buildProfiles(input({ ports: { knowledge: 19150, web: 19100 } })),
      /closer than 120/,
    );
    assert.throws(
      () => buildProfiles(input({ ports: { knowledge: 19100, web: 19100 } })),
      /share port/,
    );
    assert.throws(
      () => buildProfiles(input({ ports: { knowledge: 65500, web: 19100 } })),
      /not usable/,
    );
    assert.throws(
      () => buildProfiles(input({ ports: { knowledge: 80, web: 19100 } })),
      /not usable/,
    );
  });

  it('refuses a /v1 Ollama URL and weak or shared tokens', () => {
    assert.throws(
      () => buildProfiles(input({ ollamaUrl: 'http://x:11434/v1' })),
      /native Ollama URL/,
    );
    assert.throws(
      () =>
        buildProfiles(
          input({ tokens: { knowledge: 'short', web: 'w'.repeat(24) } }),
        ),
      /at least 16 characters/,
    );
    assert.throws(
      () =>
        buildProfiles(
          input({
            tokens: { knowledge: 'same'.repeat(6), web: 'same'.repeat(6) },
          }),
        ),
      /share one token/,
    );
  });
});

describe('checkProfiles', () => {
  const good = buildProfiles(input());

  it('accepts what buildProfiles produces', () => {
    assert.deepEqual(checkProfiles(good), []);
  });

  it('notices a knowledge skill in the web profile', () => {
    const bad = tampered(good, 'web', (config) => {
      (
        at(config, 'agents', 'entries', 'research') as { skills: string[] }
      ).skills.push('knowledge-search');
    });
    assert.match(
      checkProfiles(bad).join('\n'),
      /web profile has the knowledge-search skill/,
    );
  });

  it('notices web tools returning to the knowledge profile', () => {
    const bad = tampered(good, 'knowledge', (config) => {
      (
        at(config, 'agents', 'entries', 'knowledge', 'tools') as {
          deny: string[];
        }
      ).deny = [];
    });
    assert.match(
      checkProfiles(bad).join('\n'),
      /knowledge profile does not deny group:web/,
    );
  });

  it('notices a web profile that may run commands or leave its workspace', () => {
    const bad = tampered(good, 'web', (config) => {
      (
        at(config, 'agents', 'entries', 'research', 'tools') as {
          deny: string[];
        }
      ).deny = [];
      (config['tools'] as { fs: { workspaceOnly: boolean } }).fs.workspaceOnly =
        false;
    });
    const problems = checkProfiles(bad).join('\n');
    assert.match(problems, /does not deny group:runtime/);
    assert.match(problems, /read outside its workspace/);
  });

  it('notices a web agent that lost its skill or has another one', () => {
    for (const skills of [[], ['web-research', 'other'], ['other']]) {
      const bad = tampered(good, 'web', (config) => {
        (
          at(config, 'agents', 'entries', 'research') as { skills: string[] }
        ).skills = skills;
      });
      assert.match(
        checkProfiles(bad).join(' | '),
        /web profile must have exactly the web-research skill/,
        JSON.stringify(skills),
      );
    }
  });

  it('notices elevated exec, a reachable browser and a web that is not denied as a whole', () => {
    const open = tampered(good, 'knowledge', (config) => {
      (
        config['tools'] as { elevated: { enabled: boolean }; deny: string[] }
      ).elevated.enabled = true;
      (config['tools'] as { deny: string[] }).deny = [...CONTROL_PLANE_TOOLS];
      config['browser'] = { enabled: true };
    });
    const problems = checkProfiles(open).join(' | ');
    assert.match(
      problems,
      /knowledge allows elevated exec outside the sandbox/,
    );
    assert.match(problems, /knowledge does not deny the browser tool/);
    assert.match(problems, /knowledge leaves the browser control on/);
    assert.match(
      problems,
      /knowledge instance does not deny the web tools as a whole/,
    );
  });

  it('notices an agent whose own workspace is not the profile workspace', () => {
    const bad = tampered(good, 'web', (config) => {
      (
        at(config, 'agents', 'entries', 'research') as { workspace: string }
      ).workspace = '/srv/kc/.data';
    });
    assert.match(
      checkProfiles(bad).join(' | '),
      /web agent has a workspace that is not its own/,
    );
  });

  it('notices a missing control-plane deny, a public bind and a missing token', () => {
    const bad = tampered(good, 'web', (config) => {
      (config['tools'] as { deny: string[] }).deny = ['cron'];
      (config['gateway'] as { bind: string; auth: { token: string } }).bind =
        'lan';
      (config['gateway'] as { auth: { token: string } }).auth.token = '';
    });
    const problems = checkProfiles(bad).join('\n');
    assert.match(problems, /control-plane tool gateway/);
    assert.match(problems, /not bound to loopback/);
    assert.match(problems, /token auth/);
  });

  it('refuses a project repository that contains or sits inside a profile', () => {
    // The knowledge agent edits files in the project: it must not be able to
    // reach the configuration of either instance that way.
    assert.throws(
      () => buildProfiles(input({ projectRepo: '/srv/kc' })),
      /profile directory and the project repository overlap/,
    );
    assert.throws(
      () => buildProfiles(input({ projectRepo: '/srv/kc/.openclaw/web' })),
      /overlap/,
    );
    assert.doesNotThrow(() =>
      buildProfiles(input({ projectRepo: '/work/other' })),
    );
  });

  it('checks the directory that the knowledge agent entry really holds', () => {
    const set = buildProfiles(input());
    const tampered = (cwd: string): ProfileSet => ({
      knowledge: {
        ...set.knowledge,
        config: {
          ...set.knowledge.config,
          agents: {
            ...(set.knowledge.config['agents'] as object),
            entries: {
              knowledge: {
                ...(
                  (set.knowledge.config['agents'] as { entries: object })
                    .entries as { knowledge: object }
                ).knowledge,
                cwd,
              },
            },
          },
        },
      },
      web: set.web,
    });
    const overlap = checkProfiles(tampered(set.web.dir), {
      dataDir: '/srv/kc/.data',
    }).join(' | ');
    assert.match(
      overlap,
      /profile directory and the project repository overlap/,
    );
    const inData = checkProfiles(tampered('/srv/kc/.data/sub'), {
      dataDir: '/srv/kc/.data',
    }).join(' | ');
    assert.match(
      inData,
      /project directory of the knowledge agent is inside the data directory/,
    );
    assert.deepEqual(
      checkProfiles(tampered('/work/other'), { dataDir: '/srv/kc/.data' }),
      [],
    );
  });

  it('refuses generated profiles inside the data directory', () => {
    assert.throws(
      () => buildProfiles(input({ outDir: '/srv/kc/.data/openclaw' })),
      /profile directory is inside the data directory/,
    );
    assert.throws(
      () =>
        buildProfiles(
          input({ outDir: '/srv/kc', dataDir: '/srv/kc/web/data' }),
        ),
      /data directory is inside the web profile directory/,
    );
  });
});

describe('posix', () => {
  it('turns Windows separators into slashes only where they are separators', () => {
    assert.equal(posix('C:\\kc\\data', true), 'C:/kc/data');
    // On other systems a backslash is a character of the name.
    assert.equal(posix('/tmp/kc\\cache', false), '/tmp/kc\\cache');
  });
});

describe('isInside', () => {
  it('matches the folder itself and anything below it, not a similar name', () => {
    assert.equal(isInside('/a/b', '/a/b', false), true);
    assert.equal(isInside('/a/b/c', '/a/b', false), true);
    assert.equal(isInside('/a/bc', '/a/b', false), false);
    assert.equal(isInside('/a', '/a/b', false), false);
  });

  it('treats a filesystem root as containing everything below it', () => {
    assert.equal(isInside('/a', '/', false), true);
    assert.equal(isInside('/', '/', false), true);
    assert.equal(isInside('C:/kc', 'C:/', true), true);
    assert.equal(isInside('D:/kc', 'C:/', true), false);
  });

  it('ignores case when asked to, as on Windows', () => {
    assert.equal(isInside('C:/KC/.data/openclaw', 'c:/kc/.data', true), true);
    assert.equal(isInside('C:/KC/.data/openclaw', 'c:/kc/.data', false), false);
  });
});
