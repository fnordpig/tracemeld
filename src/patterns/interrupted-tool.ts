import type { Frame, Profile } from '../model/types.js';
import type { PatternMatch } from './types.js';
import { getAllSpans, extractKind, valuesToRecord } from '../analysis/query.js';

export function detectInterruptedTool(profile: Profile): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const allSpans = getAllSpans(profile);

  for (const span of allSpans) {
    const frameName = (profile.frames[span.frame_index] as Frame | undefined)?.name ?? '';
    const kind = extractKind(frameName);

    // Skip session/turn spans — only flag tool-level interruptions
    if (kind === 'session' || kind === 'turn' || kind === 'llm_turn' || kind === 'user_input') continue;

    const interrupted = span.args?.interrupted === true ||
      (typeof span.error === 'string' && span.error.toLowerCase().includes('interrupt'));

    if (interrupted) {
      matches.push({
        pattern: {
          name: 'interrupted_tool',
          description: `${frameName} was interrupted before completion`,
          severity: 'info',
          evidence: { frame: frameName, error: span.error },
        },
        span_ids: [span.id],
        counterfactual_savings: valuesToRecord(profile, span.values.map(v => v ?? 0)),
        recommendation: 'Interrupted tools waste the tokens spent launching them. Consider why tools are being interrupted.',
      });
    }
  }

  return matches;
}
