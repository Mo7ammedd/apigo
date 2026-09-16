import { ApigoError } from '../core/errors.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function slug(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function parseJson(value: string, label = 'JSON'): unknown {
  try { return JSON.parse(value); }
  catch { throw new ApigoError('INVALID_JSON', `Invalid ${label}.`, 2, 'Check quoting and JSON syntax; use @file.json for request bodies.'); }
}

export function validateName(value: string, kind = 'Name'): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value)) {
    throw new ApigoError('VALIDATION', `${kind} must contain 1–80 letters, numbers, dots, underscores, or hyphens.`);
  }
  return value;
}

export function round(value: number): number { return Math.round(value * 100) / 100; }

export function containsRedaction(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('[REDACTED]') || value.includes('%5BREDACTED%5D');
  if (Array.isArray(value)) return value.some(containsRedaction);
  return isRecord(value) && Object.values(value).some(containsRedaction);
}
