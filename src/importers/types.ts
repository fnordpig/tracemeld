// src/importers/types.ts
import type { Profile } from '../model/types.js';

export type ImportFormat = 'collapsed' | 'chrome_trace' | 'gecko' | 'nsight_sqlite' | 'pprof' | 'speedscope' | 'unknown';

export interface ImportedProfile {
  format: ImportFormat;
  profile: Profile;
}
