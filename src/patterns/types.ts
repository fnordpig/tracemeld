// src/patterns/types.ts
import type { Profile, DetectedPattern } from '../model/types.js';

/** A match produced by a pattern detector. */
export interface PatternMatch {
  /** The detected pattern (name, description, severity, evidence). */
  pattern: DetectedPattern;

  /** Span IDs involved in this match. */
  span_ids: string[];

  /** Estimated savings if this waste were eliminated. Keyed by value_type.key. */
  counterfactual_savings: Record<string, number>;

  /** Concrete recommendation for the LLM. */
  recommendation: string;
}

/** A pattern detector function. Pure: profile in, matches out. */
export type PatternDetector = (profile: Profile) => PatternMatch[];
