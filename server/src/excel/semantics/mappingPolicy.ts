import type { MappingSource, MappingStatus } from '../domain/types.js';

export const AI_AUTO_ACCEPT_THRESHOLD = 0.9;
export const AI_CONFIRM_THRESHOLD = 0.65;

export interface MappingDecision {
  source: MappingSource;
  confidence: number;
  status: MappingStatus;
  matched: boolean;
}

export function decideMapping(source: MappingSource, confidence = 0): MappingDecision {
  if (source === 'rule') {
    return { source, confidence: 1, status: 'accepted', matched: true };
  }
  if (confidence >= AI_AUTO_ACCEPT_THRESHOLD) {
    return { source, confidence, status: 'accepted', matched: true };
  }
  if (confidence >= AI_CONFIRM_THRESHOLD) {
    return { source, confidence, status: 'needs_confirmation', matched: false };
  }
  return { source, confidence, status: 'ignored', matched: false };
}
