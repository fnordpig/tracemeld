// src/patterns/registry.ts
import type { Profile } from '../model/types.js';
import type { PatternDetector, PatternMatch } from './types.js';

export class PatternRegistry {
  private detectors: PatternDetector[] = [];
  private cache: { profileId: string; matches: PatternMatch[] } | null = null;

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

    this.cache = { profileId: profile.id, matches };
    return matches;
  }

  getMatchesForSpan(profile: Profile, spanId: string): PatternMatch[] {
    const all = this.detect(profile);
    return all.filter((m) => m.span_ids.includes(spanId));
  }

  invalidate(): void {
    this.cache = null;
  }
}
