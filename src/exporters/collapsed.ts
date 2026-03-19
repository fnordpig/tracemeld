// src/exporters/collapsed.ts
import type { Frame, Profile } from '../model/types.js';
import { buildSpanIndex, getSpanAncestry } from '../analysis/query.js';

export function exportCollapsed(
  profile: Profile,
  dimension: number | string = 0,
): string {
  const dimIdx = typeof dimension === 'string'
    ? profile.value_types.findIndex((vt) => vt.key === dimension)
    : dimension;
  if (dimIdx < 0) return '';

  const lines: string[] = [];
  const spanIndex = buildSpanIndex(profile);

  // Export samples
  for (const lane of profile.lanes) {
    for (const sample of lane.samples) {
      const frameNames = sample.stack.map(
        (idx) => (profile.frames[idx] as Frame | undefined)?.name ?? '<unknown>',
      );
      const weight = sample.values[dimIdx] ?? 0;
      if (frameNames.length > 0 && weight > 0) {
        lines.push(`${frameNames.join(';')} ${weight}`);
      }
    }
  }

  // Export leaf spans (spans with no children) using their ancestry as the stack
  for (const lane of profile.lanes) {
    for (const span of lane.spans) {
      if (span.children.length === 0) {
        const ancestry = getSpanAncestry(profile, span, spanIndex);
        const weight = span.values[dimIdx] ?? 0;
        if (ancestry.length > 0 && weight > 0) {
          lines.push(`${ancestry.join(';')} ${weight}`);
        }
      }
    }
  }

  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
