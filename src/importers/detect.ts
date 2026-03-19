// src/importers/detect.ts
import type { ImportFormat } from './types.js';

export function detectFormat(content: string): ImportFormat {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 'unknown';

  // Try JSON formats first
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return detectArrayFormat(parsed);
      }
      if (typeof parsed === 'object' && parsed !== null) {
        return detectJsonFormat(parsed as Record<string, unknown>);
      }
    } catch {
      // Not valid JSON, fall through to text formats
    }
  }

  if (isCollapsedStacks(trimmed)) return 'collapsed';

  return 'unknown';
}

function detectJsonFormat(obj: Record<string, unknown>): ImportFormat {
  if (typeof obj['$schema'] === 'string' && obj['$schema'].includes('speedscope')) {
    return 'speedscope';
  }

  if ('traceEvents' in obj && Array.isArray(obj['traceEvents'])) {
    return 'chrome_trace';
  }

  if ('meta' in obj && 'threads' in obj && typeof obj['meta'] === 'object' && obj['meta'] !== null) {
    const meta = obj['meta'] as Record<string, unknown>;
    if (typeof meta['version'] === 'number') {
      return 'gecko';
    }
  }

  return 'unknown';
}

function detectArrayFormat(arr: unknown[]): ImportFormat {
  if (arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
    const first = arr[0] as Record<string, unknown>;
    if ('ph' in first) return 'chrome_trace';
  }
  return 'unknown';
}

function isCollapsedStacks(content: string): boolean {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  const pattern = /^.+\s+\d+$/;
  const checkCount = Math.min(lines.length, 5);
  let matchCount = 0;
  for (let i = 0; i < checkCount; i++) {
    if (pattern.test(lines[i])) matchCount++;
  }
  return matchCount / checkCount >= 0.8;
}
