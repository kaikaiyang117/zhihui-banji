import { createHash } from 'node:crypto';

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashPlan(input: {
  artifactSha256: string;
  adapterId: string;
  adapterVersion: string;
  sheetIndex: number;
  regionId: string;
  mappings: unknown;
  options: unknown;
  classId: number;
  termId: number;
}): string {
  return sha256(stableJson(input));
}

export function hashPreview(planHash: string, preview: unknown): string {
  return sha256(stableJson({ planHash, preview }));
}

/**
 * Hash the concrete business effect selected by a preview.  The rows are
 * intentionally kept out of the public plan payload; only their stable hash
 * is persisted so a database change between preview and confirmation can be
 * detected without exposing row values in the action record.
 */
export function hashBusinessEffect(input: { module: string; rows: unknown[] }): string {
  return sha256(stableJson({ module: input.module, rows: input.rows }));
}
