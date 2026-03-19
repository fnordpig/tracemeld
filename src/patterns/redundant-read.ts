// src/patterns/redundant-read.ts
import type { Frame, Profile, Span } from '../model/types.js';
import type { PatternMatch } from './types.js';
import { getAllSpans, extractKind, valuesToRecord } from '../analysis/query.js';

export function detectRedundantRead(profile: Profile): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const allSpans = getAllSpans(profile);

  // Find turn spans using extractKind
  const turnSpans = allSpans.filter((s) => {
    const name = (profile.frames[s.frame_index] as Frame | undefined)?.name ?? '';
    return extractKind(name) === 'turn';
  });

  // If no turns, treat all spans as one group
  const groups = turnSpans.length > 0
    ? turnSpans.map((t) => getDescendantsInOrder(t, allSpans))
    : [allSpans.sort((a, b) => a.start_time - b.start_time)];

  for (const descendants of groups) {
    const readsByFile = new Map<string, Span[]>();

    for (const span of descendants) {
      const frameName = (profile.frames[span.frame_index] as Frame | undefined)?.name ?? '';
      const kind = extractKind(frameName);
      const detail = frameName.includes(':') ? frameName.substring(frameName.indexOf(':') + 1) : '';

      if (kind === 'file_write' && detail) {
        readsByFile.delete(detail);
      } else if (kind === 'file_read' && detail) {
        let reads = readsByFile.get(detail);
        if (!reads) {
          reads = [];
          readsByFile.set(detail, reads);
        }
        reads.push(span);
      }
    }

    for (const [file, reads] of readsByFile) {
      if (reads.length >= 2) {
        const savings = new Array<number>(profile.value_types.length).fill(0);
        for (let i = 1; i < reads.length; i++) {
          for (let k = 0; k < savings.length; k++) {
            savings[k] += reads[i].values[k] ?? 0;
          }
        }

        matches.push({
          pattern: {
            name: 'redundant_read',
            description: `File '${file}' was read ${reads.length} times in one turn with no intervening write`,
            severity: 'warning',
            evidence: { file, read_count: reads.length },
          },
          span_ids: reads.map((s) => s.id),
          counterfactual_savings: valuesToRecord(profile, savings),
          recommendation:
            'Read the file once, retain content in reasoning, plan edits before re-reading.',
        });
      }
    }
  }

  return matches;
}

/** Walk the full subtree of a span, returning all descendants sorted by start_time. */
function getDescendantsInOrder(parent: Span, allSpans: Span[]): Span[] {
  const result: Span[] = [];
  const stack = [...parent.children];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) continue;
    const span = allSpans.find((s) => s.id === id);
    if (!span) continue;
    result.push(span);
    stack.push(...span.children);
  }
  return result.sort((a, b) => a.start_time - b.start_time);
}
