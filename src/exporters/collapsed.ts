// src/exporters/collapsed.ts
import type { Frame, Profile } from '../model/types.js';
import { getSpanAncestry } from '../analysis/query.js';

export function exportCollapsed(profile: Profile, dimensionIndex = 0): string {
  const lines: string[] = [];

  // Export samples
  for (const lane of profile.lanes) {
    for (const sample of lane.samples) {
      const frameNames = sample.stack.map(
        (idx) => (profile.frames[idx] as Frame | undefined)?.name ?? '<unknown>',
      );
      const weight = sample.values[dimensionIndex] ?? 0;
      if (frameNames.length > 0 && weight > 0) {
        lines.push(`${frameNames.join(';')} ${weight}`);
      }
    }
  }

  // Export leaf spans (spans with no children) using their ancestry as the stack
  for (const lane of profile.lanes) {
    for (const span of lane.spans) {
      if (span.children.length === 0) {
        const ancestry = getSpanAncestry(profile, span);
        const weight = span.values[dimensionIndex] ?? 0;
        if (ancestry.length > 0 && weight > 0) {
          lines.push(`${ancestry.join(';')} ${weight}`);
        }
      }
    }
  }

  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
