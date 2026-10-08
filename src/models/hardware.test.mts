import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  acceleratorBytes,
  detectHardware,
  type HardwareProbe,
  parseNvidiaSmi,
} from './hardware.mts';
import { GIB } from './types.mts';

const MIB = 1024 * 1024;

const probe = (overrides: Partial<HardwareProbe> = {}): HardwareProbe => ({
  arch: 'x64',
  platform: 'linux',
  run: async () => {
    throw new Error('nvidia-smi: command not found');
  },
  totalMemoryBytes: 32 * GIB,
  ...overrides,
});

describe('parseNvidiaSmi', () => {
  it('reads one GPU and converts MiB to bytes', () => {
    assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 3060 Ti, 8192\n'), [
      { name: 'NVIDIA GeForce RTX 3060 Ti', vramBytes: 8192 * MIB },
    ]);
  });

  it('reads several GPUs and Windows line endings', () => {
    const gpus = parseNvidiaSmi('NVIDIA A, 24576\r\nNVIDIA B, 12288\r\n');
    assert.equal(gpus.length, 2);
    assert.equal(
      acceleratorBytes({ gpus, ramBytes: 0, unifiedMemory: false }),
      36864 * MIB,
    );
  });

  it('keeps a comma inside the GPU name', () => {
    assert.deepEqual(parseNvidiaSmi('Weird, Name GPU, 4096'), [
      { name: 'Weird, Name GPU', vramBytes: 4096 * MIB },
    ]);
  });

  it('skips boards that report no memory and blank output', () => {
    assert.deepEqual(parseNvidiaSmi('NVIDIA GB10, [N/A]\n'), []);
    assert.deepEqual(parseNvidiaSmi(''), []);
    assert.deepEqual(parseNvidiaSmi('\n\n'), []);
  });
});

describe('detectHardware', () => {
  it('combines system RAM with the nvidia-smi result', async () => {
    const calls: string[][] = [];
    const hardware = await detectHardware(
      probe({
        run: async (command, args) => {
          calls.push([command, ...args]);
          return 'NVIDIA GeForce RTX 3060 Ti, 8192\n';
        },
        totalMemoryBytes: 64 * GIB,
      }),
    );
    assert.equal(hardware.ramBytes, 64 * GIB);
    assert.equal(acceleratorBytes(hardware), 8192 * MIB);
    assert.equal(hardware.unifiedMemory, false);
    assert.deepEqual(calls, [
      [
        'nvidia-smi',
        '--query-gpu=name,memory.total',
        '--format=csv,noheader,nounits',
      ],
    ]);
  });

  it('falls back to CPU only when nvidia-smi is missing', async () => {
    const hardware = await detectHardware(probe());
    assert.deepEqual(hardware.gpus, []);
    assert.equal(hardware.ramBytes, 32 * GIB);
  });

  it('treats Apple Silicon as unified memory without running nvidia-smi', async () => {
    const hardware = await detectHardware(
      probe({
        arch: 'arm64',
        platform: 'darwin',
        run: async () => {
          throw new Error('must not be called');
        },
        totalMemoryBytes: 32 * GIB,
      }),
    );
    assert.equal(hardware.unifiedMemory, true);
    assert.equal(acceleratorBytes(hardware), 24 * GIB);
  });

  it('lets overrides replace detection', async () => {
    const withGpu = await detectHardware(probe(), { ramGiB: 16, vramGiB: 12 });
    assert.equal(withGpu.ramBytes, 16 * GIB);
    assert.equal(acceleratorBytes(withGpu), 12 * GIB);

    const noGpu = await detectHardware(
      probe({ run: async () => 'NVIDIA A, 24576' }),
      { vramGiB: 0 },
    );
    assert.deepEqual(noGpu.gpus, []);
  });
});

describe('detectHardware overrides for a remote host', () => {
  const appleProbe = (extra: Partial<HardwareProbe> = {}): HardwareProbe =>
    probe({
      arch: 'arm64',
      platform: 'darwin',
      totalMemoryBytes: 32 * GIB,
      ...extra,
    });

  it('drops the local unified-memory topology when VRAM is given', async () => {
    const hardware = await detectHardware(appleProbe(), {
      ramGiB: 64,
      vramGiB: 8,
    });
    assert.equal(hardware.unifiedMemory, false);
    assert.equal(acceleratorBytes(hardware), 8 * GIB);
    assert.equal(hardware.ramBytes, 64 * GIB);
  });

  it('lets the override declare a unified-memory remote host', async () => {
    const hardware = await detectHardware(probe(), {
      ramGiB: 32,
      unifiedMemory: true,
      vramGiB: 24,
    });
    assert.equal(hardware.unifiedMemory, true);
    assert.equal(acceleratorBytes(hardware), 24 * GIB);
  });

  it('recomputes the unified GPU share from an overridden RAM size', async () => {
    const hardware = await detectHardware(appleProbe(), { ramGiB: 16 });
    assert.equal(hardware.unifiedMemory, true);
    assert.equal(acceleratorBytes(hardware), 12 * GIB);
  });

  it('can force or disable unified memory regardless of the local machine', async () => {
    const forced = await detectHardware(probe(), { unifiedMemory: true });
    assert.equal(forced.unifiedMemory, true);
    assert.equal(acceleratorBytes(forced), 24 * GIB);

    const disabled = await detectHardware(
      appleProbe({
        run: async () => 'NVIDIA A, 8192',
      }),
      { unifiedMemory: false },
    );
    assert.equal(disabled.unifiedMemory, false);
    assert.equal(acceleratorBytes(disabled), 8192 * MIB);
  });
});
