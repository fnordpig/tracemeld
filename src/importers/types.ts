// src/importers/types.ts
import type { Profile } from '../model/types.js';

export type ImportFormat = 'claude_transcript' | 'collapsed' | 'chrome_trace' | 'gecko' | 'nsight_sqlite' | 'pprof' | 'speedscope' | 'unknown';

export interface ImportedProfile {
  format: ImportFormat;
  profile: Profile;
}
