import { acceleratorBytes } from './hardware.mts';
import type {
  Candidate,
  Recommendation,
  RoleRecommendation,
} from './recommend.mts';
import { GIB } from './types.mts';

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

const billions = (count: number | undefined): string =>
  count === undefined ? '?' : `${(count / 1e9).toFixed(1)}B`;

const describe = (candidate: Candidate): string => {
  const { model, tier } = candidate;
  const active =
    model.activeParameterCount === undefined
      ? ''
      : ` (${billions(model.activeParameterCount)} active)`;
  return `${model.name}  [${tier}]  needs ${gib(candidate.needBytes)}  ${billions(model.parameterCount)}${active}`;
};

const formatRole = (
  title: string,
  rec: RoleRecommendation,
  top: number,
): string[] => {
  const lines = [title];
  rec.candidates.slice(0, top).forEach((candidate, index) => {
    lines.push(`  ${index === 0 ? '*' : '-'} ${describe(candidate)}`);
  });
  if (rec.candidates.length > top) {
    lines.push(`  ... and ${rec.candidates.length - top} more`);
  }
  if (rec.best === undefined) {
    lines.push('  no installed model can do this role');
    if (rec.pullSuggestion !== undefined) {
      lines.push(`  suggestion: ollama pull ${rec.pullSuggestion.model.name}`);
    }
  }
  return lines;
};

/** Renders a recommendation for the terminal. */
export const formatRecommendation = (rec: Recommendation, top = 5): string => {
  const vram = acceleratorBytes(rec.hardware);
  const gpu =
    rec.hardware.gpus.length === 0
      ? 'no GPU detected'
      : `${rec.hardware.gpus.map((g) => g.name).join(' + ')} (${gib(vram)})`;
  return [
    `Hardware: RAM ${gib(rec.hardware.ramBytes)}, ${gpu}`,
    '',
    ...formatRole('agent (tool calling, long context)', rec.agent, top),
    '',
    ...formatRole('embedding', rec.embedding, top),
    '',
  ].join('\n');
};
