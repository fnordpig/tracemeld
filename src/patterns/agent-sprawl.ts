import type { Frame, Profile } from '../model/types.js';
import type { PatternMatch } from './types.js';
import { getAllSpans, extractKind, valuesToRecord } from '../analysis/query.js';

export function detectAgentSprawl(profile: Profile): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const allSpans = getAllSpans(profile);

  // Find all Agent tool spans
  const agentSpans = allSpans.filter(s => {
    const name = (profile.frames[s.frame_index] as Frame | undefined)?.name ?? '';
    const kind = extractKind(name);
    return kind === 'Agent' || kind === 'agent';
  });

  if (agentSpans.length < 5) return matches;

  // Sum up wall time and any token data
  const wallIdx = profile.value_types.findIndex(vt => vt.key === 'wall_ms');
  const totalWall = agentSpans.reduce((sum, s) => sum + (s.values[wallIdx] ?? 0), 0);

  // Check args for total_tokens if available
  let totalAgentTokens = 0;
  for (const s of agentSpans) {
    totalAgentTokens += (s.args?.total_tokens as number) ?? 0;
  }

  // Flag if many agents with high cumulative cost
  const severity = agentSpans.length >= 10 ? 'warning' : 'info';

  // Counterfactual: if half the agents were eliminated, save their wall time
  const savings = new Array<number>(profile.value_types.length).fill(0);
  // Sort by wall time, mark the smaller half as waste
  const sorted = [...agentSpans].sort((a, b) => (a.values[wallIdx] ?? 0) - (b.values[wallIdx] ?? 0));
  const halfCount = Math.floor(sorted.length / 2);
  for (let i = 0; i < halfCount; i++) {
    for (let k = 0; k < savings.length; k++) {
      savings[k] += sorted[i].values[k] ?? 0;
    }
  }

  matches.push({
    pattern: {
      name: 'agent_sprawl',
      description: `${agentSpans.length} Agent subagent launches consuming ${Math.round(totalWall / 1000)}s wall time${totalAgentTokens > 0 ? ` and ~${Math.round(totalAgentTokens / 1000)}k tokens` : ''}`,
      severity,
      evidence: {
        agent_count: agentSpans.length,
        total_wall_ms: totalWall,
        total_agent_tokens: totalAgentTokens || undefined,
      },
    },
    span_ids: agentSpans.map(s => s.id),
    counterfactual_savings: valuesToRecord(profile, savings),
    recommendation: 'Each Agent subagent has its own context window and token spend. Consider doing serial tasks in the main session and reserving Agents for genuinely independent parallel work.',
  });

  return matches;
}
