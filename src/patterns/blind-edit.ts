// src/patterns/blind-edit.ts
import type { Frame, Profile, Span } from '../model/types.js';
import type { PatternMatch } from './types.js';
import { getAllSpans, buildSpanIndex, extractKind } from '../analysis/query.js';

export function detectBlindEdit(profile: Profile): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const allSpans = getAllSpans(profile);
  const spanIndex = buildSpanIndex(profile);

  // Find turn spans in order using extractKind
  const turnSpans = allSpans
    .filter((s) => {
      const name = (profile.frames[s.frame_index] as Frame | undefined)?.name ?? '';
      return extractKind(name) === 'turn';
    })
    .sort((a, b) => a.start_time - b.start_time);

  // Build a set of files read per turn by walking full subtree
  const filesReadByTurn = new Map<string, Set<string>>();

  for (const turn of turnSpans) {
    const filesRead = new Set<string>();
    collectFileOpsDeep(profile, turn, spanIndex, 'file_read', filesRead);
    filesReadByTurn.set(turn.id, filesRead);
  }

  // Check each turn's writes against current + previous turn's reads
  for (let i = 0; i < turnSpans.length; i++) {
    const turn = turnSpans[i];
    const currentReads = filesReadByTurn.get(turn.id) ?? new Set<string>();
    const prevReads =
      i > 0
        ? (filesReadByTurn.get(turnSpans[i - 1].id) ?? new Set<string>())
        : new Set<string>();
    const allReads = new Set([...currentReads, ...prevReads]);

    // Find file_write spans in this turn's subtree
    const writeSpans = getFileWriteSpansDeep(profile, turn, spanIndex);

    for (const writeSpan of writeSpans) {
      const frameName =
        (profile.frames[writeSpan.frame_index] as Frame | undefined)?.name ?? '';
      const file = frameName.includes(':')
        ? frameName.substring(frameName.indexOf(':') + 1)
        : '';
      if (file && !allReads.has(file)) {
        matches.push({
          pattern: {
            name: 'blind_edit',
            description: `Edited '${file}' without reading it first`,
            severity: 'warning',
            evidence: { file },
          },
          span_ids: [writeSpan.id],
          counterfactual_savings: {},
          recommendation: 'Always read the current state of a file before editing it.',
        });
      }
    }
  }

  // Handle case with no turn structure
  if (turnSpans.length === 0) {
    const filesRead = new Set<string>();
    const orderedSpans = [...allSpans].sort((a, b) => a.start_time - b.start_time);
    for (const span of orderedSpans) {
      const frameName =
        (profile.frames[span.frame_index] as Frame | undefined)?.name ?? '';
      const kind = extractKind(frameName);
      const detail = frameName.includes(':')
        ? frameName.substring(frameName.indexOf(':') + 1)
        : '';
      if (kind === 'file_read' && detail) {
        filesRead.add(detail);
      } else if (kind === 'file_write' && detail && !filesRead.has(detail)) {
        matches.push({
          pattern: {
            name: 'blind_edit',
            description: `Edited '${detail}' without reading it first`,
            severity: 'warning',
            evidence: { file: detail },
          },
          span_ids: [span.id],
          counterfactual_savings: {},
          recommendation: 'Always read the current state of a file before editing it.',
        });
      }
    }
  }

  return matches;
}

/** Walk the full subtree collecting file paths for a given kind prefix. */
function collectFileOpsDeep(
  profile: Profile,
  parent: Span,
  spanIndex: Map<string, Span>,
  kindPrefix: string,
  result: Set<string>,
): void {
  const stack = [...parent.children];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) continue;
    const span = spanIndex.get(id);
    if (!span) continue;
    const frameName =
      (profile.frames[span.frame_index] as Frame | undefined)?.name ?? '';
    const kind = extractKind(frameName);
    const detail = frameName.includes(':')
      ? frameName.substring(frameName.indexOf(':') + 1)
      : '';
    if (kind === kindPrefix && detail) {
      result.add(detail);
    }
    stack.push(...span.children);
  }
}

/** Walk the full subtree finding file_write spans. */
function getFileWriteSpansDeep(
  profile: Profile,
  parent: Span,
  spanIndex: Map<string, Span>,
): Span[] {
  const writes: Span[] = [];
  const stack = [...parent.children];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id) continue;
    const span = spanIndex.get(id);
    if (!span) continue;
    const frameName =
      (profile.frames[span.frame_index] as Frame | undefined)?.name ?? '';
    if (extractKind(frameName) === 'file_write') {
      writes.push(span);
    }
    stack.push(...span.children);
  }
  return writes;
}
