import type { ModelInfo } from './types.mts';

/**
 * Models to suggest pulling when nothing installed can do a role. Sizes come
 * from the Ollama library and are approximate; edit this list freely.
 */
export const PULL_CATALOG: readonly ModelInfo[] = [
  {
    activeParameterCount: 4e9,
    capabilities: ['completion', 'vision', 'tools', 'thinking'],
    contextLength: 262144,
    name: 'gemma4:26b-a4b-it-q4_K_M',
    parameterCount: 25_805_936_462,
    sizeBytes: 17_987_581_215,
  },
  {
    activeParameterCount: 2.6e9,
    capabilities: ['completion', 'tools', 'thinking'],
    contextLength: 131072,
    name: 'gpt-oss:20b',
    parameterCount: 20_914_757_184,
    sizeBytes: 13_793_441_244,
  },
  {
    activeParameterCount: undefined,
    capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'],
    contextLength: 131072,
    name: 'gemma4:e4b-it-q4_K_M',
    parameterCount: 7_518_069_290,
    sizeBytes: 6_583_656_505,
  },
  {
    activeParameterCount: undefined,
    capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'],
    contextLength: 131072,
    name: 'gemma4:e2b-it-q4_K_M',
    parameterCount: 4_647_450_147,
    sizeBytes: 4_587_156_505,
  },
  {
    activeParameterCount: undefined,
    capabilities: ['embedding'],
    contextLength: 8192,
    name: 'bge-m3',
    parameterCount: 567_000_000,
    sizeBytes: 1_200_000_000,
  },
  {
    activeParameterCount: undefined,
    capabilities: ['embedding'],
    contextLength: 2048,
    name: 'embeddinggemma',
    parameterCount: 300_000_000,
    sizeBytes: 622_000_000,
  },
];
