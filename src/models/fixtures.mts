import { GIB, type Hardware, type ModelInfo } from './types.mts';

/** Builds a machine description from sizes in GiB. */
export const machine = (
  ramGiB: number,
  vramGiB: number,
  unifiedMemory = false,
): Hardware => ({
  gpus: vramGiB > 0 ? [{ name: 'Test GPU', vramBytes: vramGiB * GIB }] : [],
  ramBytes: ramGiB * GIB,
  unifiedMemory,
});

interface ModelSpec {
  readonly name: string;
  readonly sizeGiB: number;
  readonly paramsB?: number;
  readonly activeB?: number;
  readonly contextLength?: number;
  readonly capabilities?: readonly string[];
}

/** Builds a synthetic model; agent-capable unless told otherwise. */
export const model = (spec: ModelSpec): ModelInfo => ({
  activeParameterCount:
    spec.activeB === undefined ? undefined : spec.activeB * 1e9,
  capabilities: spec.capabilities ?? ['completion', 'tools', 'thinking'],
  contextLength: spec.contextLength ?? 131072,
  name: spec.name,
  parameterCount: spec.paramsB === undefined ? undefined : spec.paramsB * 1e9,
  sizeBytes: spec.sizeGiB * GIB,
});

const real = (
  name: string,
  sizeBytes: number,
  parameterCount: number,
  contextLength: number,
  capabilities: readonly string[],
  activeParameterCount?: number,
): ModelInfo => ({
  activeParameterCount,
  capabilities,
  contextLength,
  name,
  parameterCount,
  sizeBytes,
});

/**
 * A snapshot of a real Ollama inventory (`/api/tags` + `/api/show`), used to
 * check that the recommendation behaves sensibly on a real machine.
 */
export const REAL_INVENTORY: readonly ModelInfo[] = [
  real(
    'gemma4:26b-a4b-it-q4_K_M',
    17_987_581_215,
    25_805_936_462,
    262144,
    ['completion', 'vision', 'tools', 'thinking'],
    4e9,
  ),
  real('gemma4:e4b-it-q4_K_M', 6_583_656_505, 7_518_069_290, 131072, [
    'completion',
    'vision',
    'audio',
    'tools',
    'thinking',
  ]),
  real('gemma4:e4b-it-qat', 6_146_501_801, 7_463_013_674, 131072, [
    'completion',
    'vision',
    'audio',
    'tools',
    'thinking',
  ]),
  real('ornith:9b-q4_K_M', 5_629_110_568, 8_953_803_264, 262144, [
    'completion',
    'tools',
    'thinking',
  ]),
  real('granite4.2:latest', 5_347_929_757, 8_791_592_960, 131072, [
    'tools',
    'thinking',
    'completion',
  ]),
  real('qwen3.8:27b-mtp-q4_K_M', 17_741_872_154, 27_320_697_856, 262144, [
    'completion',
    'vision',
    'tools',
    'thinking',
  ]),
  real(
    'qwen3.6:35b-a3b-coding',
    22_621_314_381,
    35_505_251_456,
    262144,
    ['completion', 'vision', 'tools', 'thinking'],
    3e9,
  ),
  real(
    'qwen3.6:35b-a3b-mtp-q4_K_M',
    22_621_314_381,
    35_505_251_456,
    262144,
    ['completion', 'vision', 'tools', 'thinking'],
    3e9,
  ),
  real(
    'magistral:24b-small-2506-q4_K_M',
    14_333_921_206,
    23_572_403_200,
    40000,
    ['completion', 'tools', 'thinking'],
  ),
  real(
    'gpt-oss:latest',
    13_793_441_244,
    20_914_757_184,
    131072,
    ['completion', 'tools', 'thinking'],
    2_614_344_648,
  ),
  real('phi4:14b-q4_K_M', 9_053_116_391, 14_659_507_200, 16384, ['completion']),
  real('smollm2:latest', 1_820_428_533, 1_711_376_384, 8192, [
    'completion',
    'tools',
  ]),
  real('tev1:4b-q4_K_M', 2_708_817_129, 4_205_751_296, 262144, ['decision']),
  real(
    'nomic-embed-text-v2-moe:latest',
    957_680_763,
    475_288_320,
    512,
    ['embedding'],
    118_822_080,
  ),
];
