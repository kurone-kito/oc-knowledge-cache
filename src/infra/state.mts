import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectHardware, type HardwareOverrides } from '../models/hardware.mts';
import { listInstalledModels } from '../models/ollama.mts';
import type { Hardware, ModelInfo } from '../models/types.mts';
import { resolveOpenClawCommand, runWithEnv } from '../openclaw/validate.mts';
import { openStore } from '../rag/store.mts';
import { inspectProfiles } from './inspect.mts';
import type { MachineState } from './plan.mts';

/** How `gatherState` looks at the machine; replaceable for tests. */
export interface StateProbe {
  detectHardware(): Promise<Hardware>;
  /** Rejects when Ollama cannot be reached. */
  listModels(): Promise<ModelInfo[]>;
  /** First line printed by `openclaw --version`; rejects when it cannot run. */
  openclawVersion(): Promise<string>;
  /** File content, or undefined when the file does not exist. */
  readText(path: string): Promise<string | undefined>;
  /** Names in a folder (folders, links and files); none when it does not exist. */
  listDirectories(path: string): Promise<string[]>;
  /** Embedding model of the cache in `dataDir`, if there is one. */
  storeModel(dataDir: string): string | undefined;
}

export interface StatePaths {
  readonly outDir: string;
  readonly dataDir: string;
  /** This repository, as the knowledge skill was generated with it. */
  readonly repoRoot?: string;
}

/** The real machine. */
export const systemProbe = (
  ollamaUrl: string,
  // For an Ollama on another machine: what that machine has.
  hardware: HardwareOverrides = {},
): StateProbe => ({
  detectHardware: () => detectHardware(undefined, hardware),
  listDirectories: async (path) => {
    try {
      // Every name counts, whatever it is: a file where a skill folder would
      // be is as much a leftover as a folder.
      return await readdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  },
  listModels: () =>
    listInstalledModels({
      baseUrl: ollamaUrl,
      signal: AbortSignal.timeout(15_000),
    }),
  openclawVersion: async () => {
    const stdout = await runWithEnv(
      [...resolveOpenClawCommand(), '--version'],
      {},
    );
    return stdout.trim().split(/\r?\n/).pop() ?? '';
  },
  readText: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  },
  storeModel: (dataDir) => {
    const file = join(dataDir, 'store.sqlite');
    if (!existsSync(file)) {
      return undefined;
    }
    const store = openStore(file, { readOnly: true });
    try {
      return store.model;
    } finally {
      store.close();
    }
  },
});

/** Looks at the machine; never changes it. */
export const gatherState = async (
  paths: StatePaths,
  probe: StateProbe,
): Promise<MachineState> => {
  const [hardware, models, openclaw, profiles] = await Promise.all([
    probe.detectHardware(),
    probe.listModels().then(
      (installedModels) => ({ installedModels, reachable: true }),
      () => ({ installedModels: [] as ModelInfo[], reachable: false }),
    ),
    probe.openclawVersion().then(
      (version) => (version === '' ? undefined : version),
      () => undefined,
    ),
    inspectProfiles(paths, probe.readText, probe.listDirectories),
  ]);
  let storeModel: string | undefined;
  try {
    storeModel = probe.storeModel(paths.dataDir);
  } catch {
    storeModel = undefined;
  }
  return {
    hardware,
    installedModels: models.installedModels,
    ollamaReachable: models.reachable,
    openclawVersion: openclaw,
    profiles,
    storeModel,
  };
};
