import { execFile } from 'node:child_process';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';
import { GIB, type GpuInfo, type Hardware } from './types.mts';

const execFileAsync = promisify(execFile);

/** Runs a command and resolves with its stdout; rejects when it fails. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<string>;

export interface HardwareProbe {
  readonly totalMemoryBytes: number;
  readonly platform: string;
  readonly arch: string;
  readonly run: CommandRunner;
}

/** Values that replace detection, e.g. when Ollama runs on another host. */
export interface HardwareOverrides {
  readonly ramGiB?: number | undefined;
  readonly vramGiB?: number | undefined;
  /** CPU and GPU share one memory pool (Apple Silicon style). */
  readonly unifiedMemory?: boolean | undefined;
}

/** Fraction of unified memory that the GPU can use on Apple Silicon. */
const UNIFIED_GPU_FRACTION = 0.75;

const NVIDIA_SMI_ARGS = [
  '--query-gpu=name,memory.total',
  '--format=csv,noheader,nounits',
] as const;

/** The real machine. */
export const systemProbe = (): HardwareProbe => ({
  arch: process.arch,
  platform: process.platform,
  run: async (command, args) =>
    (
      await execFileAsync(command, [...args], {
        timeout: 5000,
        windowsHide: true,
      })
    ).stdout,
  totalMemoryBytes: totalmem(),
});

/**
 * Parses `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`.
 * Rows without a numeric memory value (`[N/A]` on unified-memory boards) are
 * skipped.
 */
export const parseNvidiaSmi = (stdout: string): GpuInfo[] =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .flatMap((line): GpuInfo[] => {
      const separator = line.lastIndexOf(',');
      if (separator < 0) {
        return [];
      }
      const name = line.slice(0, separator).trim();
      const mebibytes = Number(line.slice(separator + 1).trim());
      return name !== '' && Number.isFinite(mebibytes) && mebibytes > 0
        ? [{ name, vramBytes: mebibytes * 1024 * 1024 }]
        : [];
    });

/** GPU memory that models can use, in bytes. */
export const acceleratorBytes = (hardware: Hardware): number =>
  hardware.gpus.reduce((sum, gpu) => sum + gpu.vramBytes, 0);

const detectNvidiaGpus = async (probe: HardwareProbe): Promise<GpuInfo[]> => {
  try {
    return parseNvidiaSmi(await probe.run('nvidia-smi', NVIDIA_SMI_ARGS));
  } catch {
    // No NVIDIA driver or binary: fall back to CPU only. GPUs of other
    // vendors can be declared with the `vramGiB` override.
    return [];
  }
};

/**
 * Detects the RAM and GPU memory of the machine that runs the models.
 *
 * Overrides describe a machine other than the local one (a remote Ollama
 * host). Giving `vramGiB` therefore also drops the locally detected memory
 * topology: the GPU is a separate pool unless `unifiedMemory` says otherwise.
 */
export const detectHardware = async (
  probe: HardwareProbe = systemProbe(),
  overrides: HardwareOverrides = {},
): Promise<Hardware> => {
  const ramBytes =
    overrides.ramGiB === undefined
      ? probe.totalMemoryBytes
      : overrides.ramGiB * GIB;

  if (overrides.vramGiB !== undefined) {
    return {
      gpus:
        overrides.vramGiB > 0
          ? [{ name: 'GPU (override)', vramBytes: overrides.vramGiB * GIB }]
          : [],
      ramBytes,
      unifiedMemory: overrides.unifiedMemory ?? false,
    };
  }

  const unifiedMemory =
    overrides.unifiedMemory ??
    (probe.platform === 'darwin' && probe.arch === 'arm64');
  if (unifiedMemory) {
    // The GPU share follows the RAM, including an overridden RAM size.
    return {
      gpus: [
        {
          name: 'Apple Silicon (unified memory)',
          vramBytes: Math.floor(ramBytes * UNIFIED_GPU_FRACTION),
        },
      ],
      ramBytes,
      unifiedMemory: true,
    };
  }
  return {
    gpus: await detectNvidiaGpus(probe),
    ramBytes,
    unifiedMemory: false,
  };
};
