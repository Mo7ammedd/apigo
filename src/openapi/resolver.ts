import { ApigoError } from '../core/errors.js';
import type { Document, Schema, SchemaObject } from '../core/types.js';
import { isRecord } from '../utils/objects.js';

export function pointer(document: Document, ref: string): unknown {
  if (ref === '#') return document;
  if (!ref.startsWith('#/')) throw new ApigoError('INVALID_REF', 'Only bundled JSON Pointer references are supported.');
  let value: unknown = document;
  for (const token of ref.slice(2).split('/')) {
    let key: string;
    try { key = decodeURIComponent(token).replace(/~1/g, '/').replace(/~0/g, '~'); }
    catch { throw new ApigoError('INVALID_REF', 'A reference contains invalid URL encoding.'); }
    if ((!isRecord(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) throw new ApigoError('INVALID_REF', 'A reference points to a missing schema or component.');
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function resolveNode(value: unknown, document: Document, seen = new Set<string>()): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (typeof value.$ref !== 'string') return value;
  if (seen.has(value.$ref)) return {};
  const next = new Set(seen).add(value.$ref);
  const { $ref, ...siblings } = value;
  return { ...resolveNode(pointer(document, $ref), document, next), ...siblings };
}

export function asSchema(value: unknown): Schema {
  return typeof value === 'boolean' || isRecord(value) ? value as Schema : {};
}

export function schemaType(schema: SchemaObject): string {
  if (Array.isArray(schema.type)) return schema.type.find(type => type !== 'null') ?? 'null';
  return schema.type ?? (schema.properties || schema.allOf ? 'object' : schema.items ? 'array' : 'string');
}

/** Resolve only the current level; children retain refs, so recursive models remain finite. */
export function resolveSchema(schema: Schema, document: Document, seen = new Set<string>()): SchemaObject {
  if (typeof schema === 'boolean') return {};
  if (schema.$ref && seen.has(schema.$ref)) return {};
  const nextSeen = new Set(seen);
  if (schema.$ref) nextSeen.add(schema.$ref);
  const result = { ...resolveNode(schema, document) } as SchemaObject;
  if (result.allOf) {
    const branches = result.allOf.map(part => resolveSchema(part, document, nextSeen));
    delete result.allOf;
    const properties: Record<string, Schema> = Object.create(null) as Record<string, Schema>;
    const required = new Set<string>();
    let merged: SchemaObject = {};
    for (const branch of [...branches, result]) {
      merged = { ...merged, ...branch };
      Object.assign(properties, branch.properties);
      branch.required?.forEach(key => required.add(key));
    }
    if (Object.keys(properties).length) merged.properties = properties;
    if (required.size) merged.required = [...required];
    return merged;
  }
  return result;
}
