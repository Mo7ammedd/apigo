import type { Document, MediaType, Schema, SchemaObject } from '../core/types.js';
import { isRecord } from '../utils/objects.js';
import { resolveSchema, schemaType } from './resolver.js';

export interface GenerateOptions { requiredOnly?: boolean; maxDepth?: number }

export function mediaExample(media: MediaType | undefined): unknown {
  if (!media) return undefined;
  if (media.example !== undefined) return structuredClone(media.example);
  const example = Object.values(media.examples ?? {}).find(item => isRecord(item) && item.value !== undefined);
  return isRecord(example) ? structuredClone(example.value) : undefined;
}

export function schemaExample(schema: SchemaObject): unknown {
  if (schema.example !== undefined) return structuredClone(schema.example);
  if (schema.examples?.length) return structuredClone(schema.examples[0]);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (schema.enum?.length) return structuredClone(schema.enum[0]);
  return undefined;
}

export function requestExample(value: unknown, schema: Schema, document: Document, depth = 0): unknown {
  if (depth > 12) return value;
  const resolved = resolveSchema(schema, document);
  if (Array.isArray(value)) return value.map(item => requestExample(item, resolved.items ?? {}, document, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const property = resolved.properties?.[key];
    if (property !== undefined && resolveSchema(property, document).readOnly) return [];
    return [[key, property === undefined ? item : requestExample(item, property, document, depth + 1)]];
  }));
}

export function generateBody(schema: Schema, document: Document, options: GenerateOptions = {}): unknown {
  function generate(input: Schema, depth: number, references: Set<string>): unknown {
    if (input === false) return undefined;
    if (input === true) return {};
    const resolved = resolveSchema(input, document);
    if (resolved.readOnly) return undefined;
    const example = schemaExample(resolved);
    if (example !== undefined) return requestExample(example, resolved, document);
    if (depth > (options.maxDepth ?? 8) || input.$ref && references.has(input.$ref)) {
      return resolved.nullable || Array.isArray(resolved.type) && resolved.type.includes('null') ? null : undefined;
    }
    const nextRefs = new Set(references);
    if (input.$ref) nextRefs.add(input.$ref);
    const alternative = (resolved.oneOf ?? resolved.anyOf)?.find(part => part !== false);
    if (alternative !== undefined) return generate({ ...resolved, ...resolveSchema(alternative, document), oneOf: undefined, anyOf: undefined }, depth, nextRefs);
    switch (schemaType(resolved)) {
      case 'null': return null;
      case 'boolean': return false;
      case 'integer': case 'number': {
        const min = typeof resolved.minimum === 'number' ? resolved.minimum : 0;
        const exclusive = typeof resolved.exclusiveMinimum === 'number' ? resolved.exclusiveMinimum + (schemaType(resolved) === 'integer' ? 1 : 0.1) : resolved.exclusiveMinimum === true ? min + 1 : min;
        let value = Math.max(min, exclusive);
        const maximum = typeof resolved.maximum === 'number' ? resolved.maximum : Infinity;
        const exclusiveMaximum = typeof resolved.exclusiveMaximum === 'number' ? resolved.exclusiveMaximum - (schemaType(resolved) === 'integer' ? 1 : 0.1) : resolved.exclusiveMaximum === true ? maximum - 1 : maximum;
        value = Math.min(value, maximum, exclusiveMaximum);
        if (schemaType(resolved) === 'integer') value = Math.ceil(value);
        if (typeof resolved.multipleOf === 'number' && resolved.multipleOf > 0) value = Math.ceil(value / resolved.multipleOf) * resolved.multipleOf;
        return value;
      }
      case 'array': {
        const count = Math.min(typeof resolved.minItems === 'number' ? Math.max(1, resolved.minItems) : 1, typeof resolved.maxItems === 'number' ? resolved.maxItems : Infinity, 20);
        const item = generate(resolved.items ?? {}, depth + 1, nextRefs);
        return item === undefined ? [] : Array.from({ length: count }, () => structuredClone(item));
      }
      case 'object': {
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [key, property] of Object.entries(resolved.properties ?? {})) {
          if (options.requiredOnly && !resolved.required?.includes(key)) continue;
          const value = generate(property, depth + 1, nextRefs);
          if (value !== undefined) result[key] = value;
        }
        return result;
      }
      default: {
        const formats: Record<string, string> = { uuid: '00000000-0000-4000-8000-000000000000', email: 'user@example.com', date: '2026-01-01', 'date-time': '2026-01-01T00:00:00Z', uri: 'https://example.com', hostname: 'example.com', ipv4: '127.0.0.1', ipv6: '::1' };
        return formats[resolved.format ?? ''] ?? ''.padEnd(Math.min(typeof resolved.minLength === 'number' ? resolved.minLength : 0, 1024), 'x');
      }
    }
  }
  return generate(schema, 0, new Set());
}
