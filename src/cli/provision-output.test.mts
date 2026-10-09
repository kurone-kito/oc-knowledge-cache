import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp.mts';

const script = fileURLToPath(new URL('./provision.mts', import.meta.url));

/** What `/api/show` says about each fake model. */
const SHOWS: Readonly<Record<string, unknown>> = {
  'agent-test:latest': {
    capabilities: ['completion', 'tools'],
    model_info: {
      'general.architecture': 'test',
      'general.parameter_count': 3_000_000_000,
      'test.context_length': 131_072,
    },
  },
  'embed-test:latest': {
    capabilities: ['embedding'],
    model_info: {
      'general.architecture': 'test',
      'general.parameter_count': 137_000_000,
      'test.context_length': 8192,
    },
  },
};

/** An Ollama that has two models installed and nothing else. */
const fakeOllama = async (): Promise<{ close: () => void; url: string }> => {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') {
        response.end(
          JSON.stringify({
            models: [
              { name: 'agent-test:latest', size: 2_000_000_000 },
              { name: 'embed-test:latest', size: 300_000_000 },
            ],
          }),
        );
      } else if (request.url === '/api/show') {
        const { model } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.end(JSON.stringify(SHOWS[model] ?? {}));
      } else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { close: () => server.close(), url: `http://127.0.0.1:${port}` };
};

const run = (
  args: string[],
  cwd: string,
): Promise<{ code: number | null; output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, KC_DATA_DIR: '' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });

describe('provision apply output', () => {
  it('prints how to start the gateways and how to talk to them, after it wrote the profiles', async (t) => {
    const root = await tempDir(t);
    const ollama = await fakeOllama();
    t.after(() => ollama.close());

    const { output } = await run(
      [
        'apply',
        '--agent-model',
        'agent-test:latest',
        '--embed-model',
        'embed-test:latest',
        '--ollama-url',
        ollama.url,
        '--out',
        join(root, 'profiles'),
        '--data',
        join(root, 'data'),
        '--ram-gib',
        '64',
        '--vram-gib',
        '24',
      ],
      root,
    );
    const lines = output.split(/\r?\n/);
    const start = lines.findIndex((line) =>
      line.startsWith('Start the gateways with these commands'),
    );
    const talk = lines.findIndex((line) =>
      line.startsWith('Talk to an instance'),
    );
    assert.ok(start >= 0, output);
    assert.ok(talk > start, 'the lines for talking come after the start lines');
    for (const [agent, port] of [
      ['research', '19100'],
      ['knowledge', '19300'],
    ] as const) {
      assert.ok(
        lines.some(
          (line) =>
            line.startsWith('POSIX shell:') &&
            line.endsWith(`openclaw gateway --port ${port}`),
        ),
        `the start line of ${agent}`,
      );
      assert.ok(
        lines.some(
          (line) =>
            line.startsWith('PowerShell:') &&
            line.endsWith(
              `openclaw agent --agent ${agent} --timeout 900 --message "..."`,
            ),
        ),
        `the one-question line of ${agent}`,
      );
    }
    assert.ok(
      lines.filter((line) => line.endsWith('openclaw tui')).length >= 4,
      'the terminal UI line of both profiles in both shells',
    );
  });
});
