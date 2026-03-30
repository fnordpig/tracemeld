// src/patterns/registry.ts
import type { Profile } from '../model/types.js';
import type { PatternDetector, PatternMatch } from './types.js';

export class PatternRegistry {
  private detectors: PatternDetector[] = [];
  private cache: { profileId: string; matches: PatternMatch[]; bySpan: Map<string, PatternMatch[]> } | null = null;

  register(detector: PatternDetector): void {
    this.detectors.push(detector);
    this.cache = null;
  }

  detect(profile: Profile): PatternMatch[] {
    if (this.cache && this.cache.profileId === profile.id) {
      return this.cache.matches;
    }

    const matches: PatternMatch[] = [];
    for (const detector of this.detectors) {
      matches.push(...detector(profile));
    }

    // Build span→matches index for O(1) lookups
    const bySpan = new Map<string, PatternMatch[]>();
    for (const match of matches) {
      for (const spanId of match.span_ids) {
        let list = bySpan.get(spanId);
        if (!list) {
          list = [];
          bySpan.set(spanId, list);
        }
        list.push(match);
      }
    }

    this.cache = { profileId: profile.id, matches, bySpan };
    return matches;
  }

  getMatchesForSpan(profile: Profile, spanId: string): PatternMatch[] {
    this.detect(profile); // ensure cache is populated
    return this.cache?.bySpan.get(spanId) ?? [];
  }

  invalidate(): void {
    this.cache = null;
  }
}
