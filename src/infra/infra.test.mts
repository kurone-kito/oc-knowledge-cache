import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { machine, REAL_INVENTORY } from '../models/fixtures.mts';
import type { ModelInfo } from '../models/types.mts';
import { generateProfiles } from '../openclaw/generate.mts';
import { realPathOf } from '../openclaw/paths.mts';
import { tempDir } from '../shared/temp.mts';
import { type ApplyDeps, applyPlan } from './apply.mts';
import { computePlan } from './plan.mts';
import { type PullFetch, pullModel } from './pull.mts';
import { gatherState, type StateProbe, systemProbe } from './state.mts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const encoder = new TextEncoder();

/** A pull response made of NDJSON lines, split into arbitrary chunks. */
const pullResponse = (lines: readonly string[], chunkSize = 7) => {
  const bytes = encoder.encode(`${lines.join('\n')}\n`);
  async function* chunks() {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield bytes.slice(i, i + chunkSize);
    }
  }
  return { body: chunks(), ok: true, status: 200, text: async () => '' };
};

describe('pullModel', () => {
  const ok = [
    '{"status":"pulling manifest"}',
    '{"status":"pulling abc","total":200,"completed":50}',
    '{"status":"pulling abc","total":200,"completed":51}',
    '{"status":"pulling abc","total":200,"completed":200}',
    '{"status":"success"}',
  ];

  it('streams progress (once per percent) and resolves on success', async () => {
    const seen: string[] = [];
    const requests: string[] = [];
    const fake: PullFetch = async (url, init) => {
      requests.push(`${url} ${init.body}`);
      return pullResponse(ok);
    };
    await pullModel({
      baseUrl: 'http://ollama.test',
      fetch: fake,
      model: 'bge-m3',
      onProgress: (line) => seen.push(line),
    });
    assert.deepEqual(requests, [
      'http://ollama.test/api/pull {"model":"bge-m3","stream":true}',
    ]);
    assert.ok(seen.includes('bge-m3: pulling manifest'));
    assert.ok(seen.includes('bge-m3: pulling abc 25%'));
    assert.ok(seen.includes('bge-m3: pulling abc 100%'));
  });

  it('copes with lines that are split across chunks, one byte at a time', async () => {
    await pullModel({
      baseUrl: 'http://x',
      fetch: async () => pullResponse(ok, 1),
      model: 'm',
    });
  });

  it('fails with the server message when the stream carries an error', async () => {
    await assert.rejects(
      pullModel({
        baseUrl: 'http://x',
        fetch: async () =>
          pullResponse([
            '{"status":"pulling manifest"}',
            '{"error":"pull model manifest: file does not exist"}',
          ]),
        model: 'nope',
      }),
      /ollama pull nope failed: pull model manifest: file does not exist/,
    );
  });

  it('fails when the stream ends without success', async () => {
    await assert.rejects(
      pullModel({
        baseUrl: 'http://x',
        fetch: async () => pullResponse(['{"status":"pulling manifest"}']),
        model: 'm',
      }),
      /ended without a success message/,
    );
  });

  it('reports an HTTP error and an unreachable server clearly', async () => {
    await assert.rejects(
      pullModel({
        baseUrl: 'http://x',
        fetch: async () => ({
          body: null,
          ok: false,
          status: 500,
          text: async () => 'boom',
        }),
        model: 'm',
      }),
      /failed with HTTP 500: boom/,
    );
    await assert.rejects(
      pullModel({
        baseUrl: 'http://x',
        fetch: async () => {
          throw new TypeError('fetch failed', {
            cause: new Error('ECONNREFUSED'),
          });
        },
        model: 'm',
      }),
      /Cannot reach Ollama at http:\/\/x: fetch failed/,
    );
  });
});

describe('pullModel stalls', () => {
  /** Sends one chunk, then nothing at all and ignores the abort signal. */
  const silentAfterFirstChunk = (): PullFetch => async () => {
    async function* chunks() {
      yield encoder.encode(`${JSON.stringify({ status: 'pulling' })}\n`);
      await new Promise<never>(() => undefined);
    }
    return { body: chunks(), ok: true, status: 200, text: async () => '' };
  };

  it('gives up on a server that stops sending, instead of waiting forever', async () => {
    await assert.rejects(
      pullModel({
        baseUrl: 'http://x',
        fetch: silentAfterFirstChunk(),
        idleTimeoutMs: 30,
        model: 'm',
      }),
      /ollama pull m stalled: no data from the server/,
    );
  });

  it('is done at the success message even if the server keeps the stream open', async () => {
    const seen: string[] = [];
    await pullModel({
      baseUrl: 'http://x',
      fetch: async () => {
        async function* openEnded() {
          yield encoder.encode(`${JSON.stringify({ status: 'pulling manifest' })}
`);
          yield encoder.encode(`${JSON.stringify({ status: 'success' })}
`);
          await new Promise<never>(() => undefined);
        }
        return {
          body: openEnded(),
          ok: true,
          status: 200,
          text: async () => '',
        };
      },
      idleTimeoutMs: 5000,
      model: 'm',
      onProgress: (line) => seen.push(line),
    });
    assert.ok(seen.some((line) => line.endsWith('success')));
  });

  it('ignores whatever follows the success message, even a broken record', async () => {
    const success = JSON.stringify({ status: 'success' });
    for (const tail of ['{"status": "succ', 'not json at all\n']) {
      await pullModel({
        baseUrl: 'http://x',
        fetch: async () => {
          const body = encoder.encode(`${success}\n${tail}`);
          return {
            body: (async function* () {
              yield body;
            })(),
            ok: true,
            status: 200,
            text: async () => '',
          };
        },
        model: 'm',
      });
    }
  });

  it('also gives up on an error body that never ends', async () => {
    await assert.rejects(
      pullModel({
        baseUrl: 'http://x',
        fetch: async () => ({
          body: null,
          ok: false,
          status: 500,
          text: () => new Promise<string>(() => undefined),
        }),
        idleTimeoutMs: 30,
        model: 'm',
      }),
      /stalled/,
    );
  });

  it('gives up on a server that never answers', async () => {
    await assert.rejects(
      pullModel({
        baseUrl: 'http://x',
        fetch: () => new Promise<never>(() => undefined),
        idleTimeoutMs: 30,
        model: 'm',
      }),
      /stalled/,
    );
  });

  it('reports a stall when the transport aborts the request itself', async () => {
    await assert.rejects(
      pullModel({
        baseUrl: 'http://x',
        fetch: (_input, init) =>
          new Promise<never>((_, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(
                new DOMException('This operation was aborted', 'AbortError'),
              ),
            );
          }),
        idleTimeoutMs: 30,
        model: 'm',
      }),
      /stalled/,
    );
  });

  it('keeps a slow download going as long as data keeps arriving', async () => {
    const lines = [
      JSON.stringify({ completed: 1, status: 'pulling', total: 4 }),
      JSON.stringify({ completed: 2, status: 'pulling', total: 4 }),
      JSON.stringify({ completed: 4, status: 'pulling', total: 4 }),
      JSON.stringify({ status: 'success' }),
    ];
    const seen: string[] = [];
    await pullModel({
      baseUrl: 'http://x',
      fetch: async () => {
        async function* slow() {
          for (const line of lines) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            yield encoder.encode(`${line}\n`);
          }
        }
        return { body: slow(), ok: true, status: 200, text: async () => '' };
      },
      idleTimeoutMs: 60,
      model: 'm',
      onProgress: (line) => seen.push(line),
    });
    assert.ok(seen.some((line) => line.endsWith('100%')));
  });
});

const probe = (extra: Partial<StateProbe> = {}): StateProbe => ({
  detectHardware: async () => machine(63.8, 8),
  listModels: async () => [...REAL_INVENTORY],
  openclawVersion: async () => 'OpenClaw 2026.9.9 (abc)',
  // Real folders where there are any (the tests that generate profiles).
  listDirectories: systemProbe('http://127.0.0.1:11434').listDirectories,
  readText: async () => undefined,
  storeModel: () => undefined,
  ...extra,
});

describe('gatherState', () => {
  const paths = { dataDir: '/d', outDir: '/o' };

  it('describes a machine without profiles', async () => {
    const state = await gatherState(paths, probe());
    assert.equal(state.ollamaReachable, true);
    assert.equal(state.installedModels.length, REAL_INVENTORY.length);
    assert.equal(state.openclawVersion, 'OpenClaw 2026.9.9 (abc)');
    assert.deepEqual(state.profiles.problems, [
      'the OpenClaw profiles have not been generated',
    ]);
    assert.equal(state.profiles.agentModel, undefined);
  });

  it('reports configs that are not JSON objects as problems to repair', async () => {
    for (const content of ['{ broken', 'null', '[]']) {
      const state = await gatherState(
        paths,
        probe({ readText: async () => content }),
      );
      assert.ok(
        state.profiles.problems.some((p) => /is not a JSON object/.test(p)),
        content,
      );
      assert.equal(state.profiles.agentModel, undefined);
    }
  });

  it('survives an unreachable Ollama, a missing OpenClaw and an unreadable store', async () => {
    const state = await gatherState(
      paths,
      probe({
        listModels: async () => {
          throw new Error('ECONNREFUSED');
        },
        openclawVersion: async () => {
          throw new Error('spawn openclaw ENOENT');
        },
        storeModel: () => {
          throw new Error('database disk image is malformed');
        },
      }),
    );
    assert.equal(state.ollamaReachable, false);
    // The reason is kept, so that the plan can tell a server that is down
    // from one that is up and failing.
    assert.equal(state.ollamaError, 'ECONNREFUSED');
    assert.deepEqual(state.installedModels, []);
    assert.equal(state.openclawVersion, undefined);
    assert.equal(state.storeModel, undefined);
  });

  it('has no Ollama error when the model list was read', async () => {
    const state = await gatherState(paths, probe());
    assert.equal(state.ollamaReachable, true);
    assert.equal(state.ollamaError, undefined);
  });

  it('reports the model of an existing cache', async () => {
    const state = await gatherState(
      paths,
      probe({ storeModel: () => 'bge-m3' }),
    );
    assert.equal(state.storeModel, 'bge-m3');
  });
});

describe('applyPlan', () => {
  const recorder = () => {
    const calls: string[] = [];
    const deps: ApplyDeps = {
      log: () => {},
      pull: async (model) => {
        calls.push(`pull ${model}`);
      },
      render: async (agentModel) => {
        calls.push(`render ${agentModel}`);
        return ['a', 'b'];
      },
    };
    return { calls, deps };
  };

  const emptyMachine = {
    hardware: machine(63.8, 8),
    installedModels: [] as ModelInfo[],
    ollamaReachable: true,
    openclawVersion: undefined,
    profiles: {
      agentModel: undefined,
      ollamaUrl: undefined,
      problems: ['the OpenClaw profiles have not been generated'],
      projectRepo: undefined,
    },
    storeModel: undefined,
  };

  it('does the automatic steps in order and only reports the manual one', async () => {
    const { calls, deps } = recorder();
    const report = await applyPlan(computePlan(emptyMachine), deps);
    assert.deepEqual(calls, [
      'pull gemma4:26b-a4b-it-q4_K_M',
      'pull bge-m3',
      'render gemma4:26b-a4b-it-q4_K_M',
    ]);
    assert.equal(report.failed.length, 0);
    assert.deepEqual(
      report.manual.map((a) => a.kind === 'manual' && a.topic),
      ['install-openclaw'],
    );
  });

  it('still generates the profiles when only the embedding model could not be pulled', async () => {
    const { calls, deps } = recorder();
    const report = await applyPlan(computePlan(emptyMachine), {
      ...deps,
      pull: async (model) => {
        if (model === 'bge-m3') {
          throw new Error('disk full');
        }
        calls.push(`pull ${model}`);
      },
    });
    assert.deepEqual(calls, [
      'pull gemma4:26b-a4b-it-q4_K_M',
      'render gemma4:26b-a4b-it-q4_K_M',
    ]);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0]?.error ?? '', /disk full/);
  });

  it('pulls a tag chosen for both roles once, and lets that one pull decide', async () => {
    const plan = computePlan(emptyMachine, {
      agentModel: 'shared:latest',
      embeddingModel: 'shared:latest',
    });
    assert.equal(plan.actions.filter((a) => a.kind === 'pull-model').length, 1);

    const ok = recorder();
    const done = await applyPlan(plan, ok.deps);
    assert.deepEqual(ok.calls, ['pull shared:latest', 'render shared:latest']);
    assert.equal(done.failed.length, 0);

    const broken = recorder();
    const failed = await applyPlan(plan, {
      ...broken.deps,
      pull: async () => {
        throw new Error('pull failed');
      },
    });
    assert.equal(failed.failed.length, 1);
    assert.deepEqual(
      broken.calls,
      [],
      'no profiles for a model that is not there',
    );
  });

  it('does not generate profiles for an agent model that could not be pulled', async () => {
    const { calls, deps } = recorder();
    const report = await applyPlan(computePlan(emptyMachine), {
      ...deps,
      pull: async (model) => {
        if (model.startsWith('gemma4')) {
          throw new Error('no space left');
        }
        calls.push(`pull ${model}`);
      },
    });
    assert.deepEqual(calls, ['pull bge-m3']);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0]?.error ?? '', /no space left/);
  });

  it('is idempotent: after it ran, planning again leaves only the manual step', async () => {
    const installed: ModelInfo[] = [];
    let rendered: string | undefined;
    const world = () => ({
      ...emptyMachine,
      installedModels: [...installed],
      profiles:
        rendered === undefined
          ? emptyMachine.profiles
          : {
              agentModel: rendered,
              ollamaUrl: undefined,
              problems: [],
              projectRepo: undefined,
            },
    });
    const deps: ApplyDeps = {
      log: () => {},
      pull: async (model) => {
        const embedding = model === 'bge-m3';
        installed.push({
          activeParameterCount: undefined,
          capabilities: embedding ? ['embedding'] : ['completion', 'tools'],
          contextLength: 131072,
          name: model,
          parameterCount: 1e9,
          sizeBytes: 1e9,
        });
      },
      render: async (agentModel) => {
        rendered = agentModel;
        return [];
      },
    };

    const first = await applyPlan(computePlan(world()), deps);
    assert.ok(first.done.length >= 3);
    const second = computePlan(world());
    assert.deepEqual(
      second.actions.map((a) => a.kind),
      ['manual'],
      'only installing OpenClaw is left',
    );
    const third = await applyPlan(second, deps);
    assert.deepEqual(third.done, []);
  });
});

describe('profiles on disk', () => {
  const URL = 'http://127.0.0.1:11434';
  const MODEL = 'qwen3.6:35b-a3b-coding';

  /** Generates real profiles, and looks at them the way `provision` does. */
  const generated = async (
    t: Parameters<typeof tempDir>[0],
    { withRepo = false }: { withRepo?: boolean } = {},
  ) => {
    const root = await tempDir(t);
    const repo = join(root, 'app');
    const paths = {
      dataDir: join(root, 'data'),
      outDir: join(root, 'openclaw'),
    };
    await generateProfiles({
      ...paths,
      model: MODEL,
      ollamaUrl: URL,
      ...(withRepo ? { projectRepo: repo } : {}),
      repoRoot,
    });
    const look = () =>
      gatherState(paths, probe({ readText: systemProbe(URL).readText })).then(
        (state) => state.profiles,
      );
    return { look, paths, repo, root };
  };

  it('accepts what a generation wrote, and the next plan has nothing to do', async (t) => {
    const { paths } = await generated(t);
    const state = await gatherState(
      paths,
      probe({ readText: systemProbe(URL).readText }),
    );
    assert.deepEqual(state.profiles.problems, []);
    assert.equal(state.profiles.agentModel, MODEL);
    assert.equal(state.profiles.ollamaUrl, URL);
    assert.equal(state.profiles.projectRepo, undefined);
    assert.deepEqual(
      computePlan(state, { ollamaUrl: URL }).actions.map((a) => a.kind),
      [],
    );
  });

  it('keeps the one port that works when the other is missing or unusable', async (t) => {
    const { look, paths } = await generated(t);
    const file = join(paths.outDir, 'knowledge', 'openclaw.json');
    const original = JSON.parse(await readFile(file, 'utf8'));

    const missing = structuredClone(original);
    delete missing.gateway.port;
    await writeFile(file, JSON.stringify(missing));
    const onlyWeb = await look();
    assert.ok(onlyWeb.problems.some((p) => /no valid port/.test(p)));
    assert.deepEqual(onlyWeb.ports, { knowledge: 19300, web: 19100 });

    // Both present, but the knowledge port is too close to the web one.
    const close = structuredClone(original);
    close.gateway.port = 19110;
    await writeFile(file, JSON.stringify(close));
    const tooClose = await look();
    assert.ok(
      tooClose.problems.some((p) =>
        /ports 19100 and 19110 are closer than 120/.test(p),
      ),
    );
    assert.deepEqual(tooClose.ports, { knowledge: 19300, web: 19100 });
  });

  it('reports the ports of the generated configs so a new generation keeps them', async (t) => {
    const root = await tempDir(t);
    const paths = {
      dataDir: join(root, 'data'),
      outDir: join(root, 'openclaw'),
    };
    await generateProfiles({
      ...paths,
      model: MODEL,
      ollamaUrl: URL,
      ports: { knowledge: 19500, web: 19200 },
      repoRoot,
    });
    const state = await gatherState(
      paths,
      probe({ readText: systemProbe(URL).readText }),
    );
    assert.deepEqual(state.profiles.problems, []);
    assert.deepEqual(state.profiles.ports, { knowledge: 19500, web: 19200 });
  });

  it('does not judge hand-edited ports, and keeps only ports a generation would accept', async (t) => {
    const { look, paths } = await generated(t);
    const file = join(paths.outDir, 'knowledge', 'openclaw.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    config.gateway.port = 19350;
    await writeFile(file, JSON.stringify(config));
    const accepted = await look();
    assert.deepEqual(accepted.problems, []);
    assert.deepEqual(accepted.ports, { knowledge: 19350, web: 19100 });

    // Too close to the other gateway: a problem to repair, and not a port that
    // a new generation could use; the other one is kept.
    config.gateway.port = 19110;
    await writeFile(file, JSON.stringify(config));
    const refused = await look();
    assert.ok(refused.problems.some((p) => /are closer than 120/.test(p)));
    assert.deepEqual(refused.ports, { knowledge: 19300, web: 19100 });
  });

  it('reports a config or skill that is only a link to a valid-looking file', async (t) => {
    const { look, paths, root } = await generated(t);
    const real = join(paths.outDir, 'knowledge', 'openclaw.json');
    const copy = join(root, 'copy.json');
    await writeFile(copy, await readFile(real, 'utf8'));
    await rm(real);
    try {
      await symlink(copy, real, 'file');
    } catch {
      t.skip('file links cannot be created here');
      return;
    }
    assert.ok((await look()).blockers?.some((p) => /is a link/.test(p)));
  });

  it('reports a folder where a config belongs, and a loop in the project directory, instead of failing', async (t) => {
    const { look, paths } = await generated(t, { withRepo: true });
    const knowledge = join(paths.outDir, 'knowledge', 'openclaw.json');
    const original = await readFile(knowledge, 'utf8');

    const web = join(paths.outDir, 'web', 'openclaw.json');
    const webOriginal = await readFile(web, 'utf8');
    await rm(web);
    await mkdir(web);
    const folder = await look();
    assert.ok(
      folder.blockers?.some((p) =>
        /openclaw.json cannot be read as a file/.test(p),
      ),
    );
    await rm(web, { recursive: true });
    await writeFile(web, webOriginal);

    // A parent of a generated file that is itself a plain file.
    const skills = join(paths.outDir, 'web', 'workspace', 'skills');
    await rm(skills, { recursive: true });
    await writeFile(skills, 'not a folder');
    const parent = await look();
    assert.ok(
      parent.blockers?.some((p) =>
        /cannot be (read as a file|listed as a folder)/.test(p),
      ),
    );
    await rm(skills);

    // A project directory that is a loop of links.
    const loopA = join(paths.outDir, '..', 'loop-a');
    const loopB = join(paths.outDir, '..', 'loop-b');
    try {
      await symlink(
        loopB,
        loopA,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await symlink(
        loopA,
        loopB,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      return;
    }
    const config = JSON.parse(original);
    config.agents.entries.knowledge.cwd = join(loopA, 'x');
    await writeFile(knowledge, JSON.stringify(config));
    const looped = await look();
    assert.ok(looped.problems.some((p) => /cannot be resolved/.test(p)));
  });

  it('notices a changed server or project repository', async (t) => {
    const { paths, repo, root } = await generated(t, { withRepo: true });
    const state = await gatherState(
      paths,
      probe({ readText: systemProbe(URL).readText }),
    );
    // The command resolves the folder it is given before it plans with it.
    const same = { ollamaUrl: URL, projectRepo: await realPathOf(repo) };
    assert.deepEqual(computePlan(state, same).actions, []);
    assert.deepEqual(
      computePlan(state, {
        ...same,
        ollamaUrl: 'http://other:11434',
      }).actions.map((a) => a.kind),
      ['render-profiles'],
    );
    assert.deepEqual(
      computePlan(state, {
        ...same,
        projectRepo: join(root, 'else'),
      }).actions.map((a) => a.kind),
      ['render-profiles'],
    );
    assert.deepEqual(
      computePlan(state, { ollamaUrl: URL }).actions.map((a) => a.kind),
      ['render-profiles'],
      'leaving the option out means no project repository',
    );
  });

  it('notices a web config that is broken, outdated or lost its restrictions', async (t) => {
    const { look, paths } = await generated(t);
    const file = join(paths.outDir, 'web', 'openclaw.json');
    const original = await readFile(file, 'utf8');

    await writeFile(file, '{ broken');
    assert.ok(
      (await look()).problems.some((p) => /web openclaw\.json is not/.test(p)),
    );

    const config = JSON.parse(original);
    config.agents.defaults.model.primary = 'ollama/gpt-oss:latest';
    await writeFile(file, JSON.stringify(config));
    const outdated = await look();
    assert.deepEqual(outdated.problems.length, 1);
    assert.match(outdated.problems[0] ?? '', /same agent model/);

    const open = JSON.parse(original);
    open.tools.fs.workspaceOnly = false;
    await writeFile(file, JSON.stringify(open));
    assert.ok(
      (await look()).problems.some((p) => /outside its workspace/.test(p)),
    );

    await rm(file);
    assert.ok(
      (await look()).problems.some((p) =>
        /web profile has no openclaw/.test(p),
      ),
    );
  });

  it('notices a missing skill', async (t) => {
    const { look, paths } = await generated(t);
    await rm(join(paths.outDir, 'knowledge', 'workspace', 'skills'), {
      force: true,
      recursive: true,
    });
    assert.ok(
      (await look()).problems.some((p) =>
        /knowledge profile lacks the knowledge-search skill/.test(p),
      ),
    );
  });

  it('accepts profiles whichever way their folder is spelled, links included', async (t) => {
    const root = await tempDir(t);
    const real = join(root, 'real');
    await mkdir(real);
    const alias = join(root, 'alias');
    try {
      await symlink(
        real,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      t.skip('links cannot be created here');
      return;
    }
    await generateProfiles({
      dataDir: join(root, 'data'),
      model: MODEL,
      ollamaUrl: URL,
      outDir: join(alias, 'oc'),
      repoRoot,
    });
    for (const outDir of [join(alias, 'oc'), join(real, 'oc')]) {
      const state = await gatherState(
        { dataDir: join(root, 'data'), outDir },
        probe({ readText: systemProbe(URL).readText }),
      );
      assert.deepEqual(state.profiles.problems, [], outDir);
    }
  });

  it('notices an agent that overrides the model, a provider without it, and a port outside the usable range', async (t) => {
    const { look, paths } = await generated(t);
    const file = join(paths.outDir, 'web', 'openclaw.json');
    const original = await readFile(file, 'utf8');

    const override = JSON.parse(original);
    override.agents.entries.research.model = { primary: 'ollama/other:latest' };
    await writeFile(file, JSON.stringify(override));
    assert.ok(
      (await look()).problems.some((p) =>
        /web agent runs ollama\/other:latest/.test(p),
      ),
    );

    // A model setting that is present but not a model name is broken, not
    // an absent override.
    for (const broken of [
      42,
      { primary: 42 },
      {},
      { fallbacks: [] },
      null,
      ['x'],
    ]) {
      const bad = JSON.parse(original);
      bad.agents.entries.research.model = broken;
      await writeFile(file, JSON.stringify(bad));
      assert.ok(
        (await look()).problems.some((p) =>
          /web agent has a model setting that is not valid/.test(p),
        ),
        JSON.stringify(broken),
      );
    }
    // The same model under another spelling is no override.
    const same = JSON.parse(original);
    same.agents.entries.research.model = `ollama/${MODEL}:latest`;
    await writeFile(file, JSON.stringify(same));
    assert.deepEqual((await look()).problems, []);

    const undefinedModel = JSON.parse(original);
    undefinedModel.models.providers.ollama.models = [];
    await writeFile(file, JSON.stringify(undefinedModel));
    assert.ok(
      (await look()).problems.some((p) =>
        /web provider does not define the model/.test(p),
      ),
    );

    for (const port of [80, 65_535]) {
      const outOfRange = JSON.parse(original);
      outOfRange.gateway.port = port;
      await writeFile(file, JSON.stringify(outOfRange));
      assert.ok(
        (await look()).problems.some((p) =>
          /web gateway port \d+ is not usable/.test(p),
        ),
        String(port),
      );
    }
    await writeFile(file, original);
    assert.deepEqual((await look()).problems, []);
  });

  it('reports a missing or malformed port, a malformed project directory, and a path that only starts like the right one', async (t) => {
    const { look, paths } = await generated(t, { withRepo: true });
    const file = join(paths.outDir, 'knowledge', 'openclaw.json');
    const original = await readFile(file, 'utf8');

    const noPort = JSON.parse(original);
    delete noPort.gateway.port;
    await writeFile(file, JSON.stringify(noPort));
    assert.ok(
      (await look()).problems.some((p) =>
        /knowledge gateway has no valid port/.test(p),
      ),
    );
    noPort.gateway.port = '19300';
    await writeFile(file, JSON.stringify(noPort));
    assert.ok(
      (await look()).problems.some((p) =>
        /knowledge gateway has no valid port/.test(p),
      ),
    );

    const badCwd = JSON.parse(original);
    badCwd.agents.entries.knowledge.cwd = 42;
    await writeFile(file, JSON.stringify(badCwd));
    assert.ok(
      (await look()).problems.some((p) =>
        /project directory that is not text/.test(p),
      ),
    );

    // The skill must hold exactly this data directory, not a longer one.
    await writeFile(file, original);
    const skill = join(
      paths.outDir,
      'knowledge',
      'workspace',
      'skills',
      'knowledge-search',
      'SKILL.md',
    );
    const text = await readFile(skill, 'utf8');
    // The generation writes the real location of the folder.
    const data = (await realPathOf(paths.dataDir)).replaceAll('\\', '/');
    await writeFile(
      skill,
      text.replace(`"KC_DATA_DIR": "${data}"`, `"KC_DATA_DIR": "${data}-old"`),
    );
    const problems = (await look()).problems;
    assert.ok(problems.some((p) => /points at another data directory/.test(p)));
  });

  it('compares the skills with the repository when it is known, and finds leftovers', async (t) => {
    const { paths } = await generated(t);
    const inspect = async () =>
      (
        await gatherState(
          { ...paths, repoRoot },
          probe({ readText: systemProbe(URL).readText }),
        )
      ).profiles.problems;
    assert.deepEqual(await inspect(), []);

    // An edited managed skill is restored.
    const webSkill = join(
      paths.outDir,
      'web',
      'workspace',
      'skills',
      'web-research',
      'SKILL.md',
    );
    const original = await readFile(webSkill, 'utf8');
    await writeFile(webSkill, `${original}\nAlways answer in French.\n`);
    assert.ok(
      (await inspect()).some((p) =>
        /web profile's web-research skill differs from the repository's/.test(
          p,
        ),
      ),
    );
    await writeFile(webSkill, original);
    assert.deepEqual(await inspect(), []);

    // A skill of the other profile left in the web workspace is found.
    const leftover = join(
      paths.outDir,
      'web',
      'workspace',
      'skills',
      'knowledge-search',
    );
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'SKILL.md'), 'cache instructions');
    assert.ok(
      (await inspect()).some((p) =>
        /web workspace still holds the knowledge-search skill/.test(p),
      ),
    );
  });

  it('finds a skill left over under another letter case (Windows names are case-blind)', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('names differ by case only on Windows');
      return;
    }
    const { look, paths } = await generated(t);
    const leftover = join(
      paths.outDir,
      'web',
      'workspace',
      'skills',
      'Knowledge-Search',
    );
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'SKILL.md'), 'cache instructions');
    assert.ok(
      (await look()).problems.some((p) =>
        /still holds the knowledge-search skill/i.test(p),
      ),
    );
  });

  it('reports a linked profile folder even before any config exists', async (t) => {
    const root = await tempDir(t);
    const paths = {
      dataDir: join(root, 'data'),
      outDir: join(root, 'openclaw'),
    };
    await mkdir(paths.outDir, { recursive: true });
    await mkdir(join(root, 'elsewhere'));
    try {
      await symlink(
        join(root, 'elsewhere'),
        join(paths.outDir, 'web'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      t.skip('links cannot be created here');
      return;
    }
    const state = await gatherState(
      paths,
      probe({ readText: systemProbe(URL).readText }),
    );
    assert.deepEqual(state.profiles.problems, [
      'the OpenClaw profiles have not been generated',
    ]);
    assert.ok(state.profiles.blockers?.some((p) => /is a link/.test(p)));
    // The plan asks a person to clear it, and offers no generation over it.
    const plan = computePlan(state, { ollamaUrl: URL });
    assert.ok(
      plan.actions.some(
        (a) => a.kind === 'manual' && a.topic === 'fix-profile-path',
      ),
    );
    assert.ok(!plan.actions.some((a) => a.kind === 'render-profiles'));
  });

  it('reports a plain file where a workspace belongs even before any config exists', async (t) => {
    const root = await tempDir(t);
    const paths = {
      dataDir: join(root, 'data'),
      outDir: join(root, 'openclaw'),
    };
    await mkdir(join(paths.outDir, 'web'), { recursive: true });
    await writeFile(join(paths.outDir, 'web', 'workspace'), 'not a folder');
    const state = await gatherState(
      paths,
      probe({ readText: systemProbe(URL).readText }),
    );
    assert.ok(
      state.profiles.blockers?.some((p) =>
        /workspace is a file where a folder belongs/.test(p),
      ),
    );
    const plan = computePlan(state, { ollamaUrl: URL });
    assert.ok(!plan.actions.some((a) => a.kind === 'render-profiles'));
  });

  it('finds a plain file named after a forbidden skill, and a file where the state folder belongs', async (t) => {
    const { look, paths } = await generated(t);
    const leftover = join(
      paths.outDir,
      'web',
      'workspace',
      'skills',
      'knowledge-search',
    );
    await writeFile(leftover, 'cache instructions');
    assert.ok(
      (await look()).problems.some((p) =>
        /web workspace still holds the knowledge-search skill/.test(p),
      ),
    );
    await rm(leftover);
    assert.deepEqual((await look()).problems, []);

    // The state folder may be missing (OpenClaw makes it), but not a file.
    const state = join(paths.outDir, 'knowledge', 'state');
    await writeFile(state, 'not a folder');
    assert.ok(
      (await look()).blockers?.some((p) =>
        /cannot be listed as a folder/.test(p),
      ),
    );
    await rm(state);
    assert.deepEqual((await look()).problems, []);
  });

  it('treats equivalent model and URL spellings in the two configs as one', async (t) => {
    const { look, paths } = await generated(t);
    const knowledge = join(paths.outDir, 'knowledge', 'openclaw.json');
    const web = join(paths.outDir, 'web', 'openclaw.json');
    const config = JSON.parse(await readFile(knowledge, 'utf8'));
    config.agents.defaults.model.primary = `ollama/${MODEL}:latest`;
    config.models.providers.ollama.models[0].id = `${MODEL}:latest`;
    // The agent's own setting matches its own config, not the other one's.
    config.agents.entries.knowledge.model = {
      primary: `ollama/${MODEL}:latest`,
    };
    await writeFile(knowledge, JSON.stringify(config));
    const other = JSON.parse(await readFile(web, 'utf8'));
    other.models.providers.ollama.baseUrl = `${URL}/`;
    await writeFile(web, JSON.stringify(other));
    const found = await look();
    assert.deepEqual(found.problems, []);
    assert.equal(found.agentModel, MODEL);
    assert.equal(found.ollamaUrl, URL);
  });

  it('describes the machine that runs Ollama when asked to', async () => {
    const hardware = await systemProbe(URL, {
      ramGiB: 16,
      vramGiB: 0,
    }).detectHardware();
    assert.equal(hardware.ramBytes, 16 * 1024 ** 3);
    assert.deepEqual(hardware.gpus, []);
  });

  it('notices a skill that searches with another Ollama server than the profile uses', async (t) => {
    const { look, paths } = await generated(t);
    const skill = join(
      paths.outDir,
      'knowledge',
      'workspace',
      'skills',
      'knowledge-search',
      'SKILL.md',
    );
    const text = await readFile(skill, 'utf8');
    assert.deepEqual((await look()).problems, []);
    await writeFile(
      skill,
      text.replace(
        '"OLLAMA_HOST": "http://127.0.0.1:11434"',
        '"OLLAMA_HOST": "http://other:11434"',
      ),
    );
    assert.ok(
      (await look()).problems.some((p) =>
        /points at another Ollama server/.test(p),
      ),
    );
  });

  it('notices a skill that points at another data directory or repository', async (t) => {
    const { paths } = await generated(t);
    const inspect = async (extra: { dataDir?: string; repoRoot?: string }) =>
      (
        await gatherState(
          { ...paths, ...extra },
          probe({ readText: systemProbe(URL).readText }),
        )
      ).profiles.problems;
    assert.deepEqual(await inspect({ repoRoot }), []);
    assert.ok(
      (await inspect({ dataDir: join(paths.dataDir, '..', 'other') })).some(
        (p) => /points at another data directory/.test(p),
      ),
    );
    assert.ok(
      (await inspect({ repoRoot: join(paths.outDir, 'elsewhere') })).some((p) =>
        /points at another repository/.test(p),
      ),
    );
  });

  it('notices an agent workspace or project directory that reaches a profile', async (t) => {
    const { look, paths } = await generated(t);
    const web = join(paths.outDir, 'web', 'openclaw.json');
    const knowledge = join(paths.outDir, 'knowledge', 'openclaw.json');
    const original = await readFile(web, 'utf8');
    const config = JSON.parse(original);
    config.agents.entries.research.workspace = paths.dataDir;
    await writeFile(web, JSON.stringify(config));
    assert.ok(
      (await look()).problems.some((p) =>
        /workspace that is not its own/.test(p),
      ),
    );
    await writeFile(web, original);

    const cwdConfig = JSON.parse(await readFile(knowledge, 'utf8'));
    cwdConfig.agents.entries.knowledge.cwd = join(paths.outDir, 'web');
    await writeFile(knowledge, JSON.stringify(cwdConfig));
    assert.ok((await look()).problems.some((p) => /overlap/.test(p)));
  });

  it('leaves settings that were added by hand alone', async (t) => {
    const { look, paths } = await generated(t);
    const file = join(paths.outDir, 'knowledge', 'openclaw.json');
    const config = JSON.parse(await readFile(file, 'utf8'));
    config.gateway.port = 19350;
    config.ui = { theme: 'dark' };
    await writeFile(file, JSON.stringify(config));
    assert.deepEqual((await look()).problems, []);
  });
});
