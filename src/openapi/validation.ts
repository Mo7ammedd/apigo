import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { ApigoError } from '../core/errors.js';
import type { Document, Schema } from '../core/types.js';
import { isRecord, record } from '../utils/objects.js';
import { resolveSchema, schemaType } from './resolver.js';

function requestSchema(value: unknown, document: Document): unknown {
  if (Array.isArray(value)) return value.map(item => requestSchema(item, document));
  if (!isRecord(value)) return value;
  if (value.$dynamicRef !== undefined) throw new ApigoError('UNSUPPORTED_SCHEMA', 'Dynamic JSON Schema references are not supported in this MVP.');
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(value).filter(([key]) => !['example', 'examples', 'default', '$schema', '$id', 'xml', 'discriminator'].includes(key)).map(([key, child]) => [key, requestSchema(child, document)]));
  if (Array.isArray(value.required) && isRecord(value.properties)) {
    result.required = value.required.filter(key => typeof key === 'string' && !resolveSchema(record(value.properties)[key] as Schema ?? {}, document).readOnly);
  }
  if (result.nullable === true && Array.isArray(result.type)) {
    if (!result.type.includes('null')) result.type.push('null');
    delete result.nullable;
  }
  if (result.nullable === true && result.type === undefined) delete result.nullable;
  for (const name of ['Minimum', 'Maximum']) {
    const exclusive = `exclusive${name}`;
    const bound = name.toLowerCase();
    if (typeof result[exclusive] === 'boolean') {
      if (result[exclusive] === true && typeof result[bound] === 'number') { result[exclusive] = result[bound]; delete result[bound]; }
      else delete result[exclusive];
    }
  }
  return result;
}

export function validateValue(value: unknown, schema: Schema, document: Document, label: string): void {
  const modern = typeof document.openapi === 'string' && document.openapi.startsWith('3.1');
  const ajv = modern ? new Ajv2020({ strict: false, allErrors: true, logger: false }) : new Ajv({ strict: false, allErrors: true, logger: false });
  (formats as unknown as FormatsPlugin)(ajv, { mode: 'fast' });
  for (const format of ['int32', 'int64', 'float', 'double', 'byte', 'binary', 'password']) ajv.addFormat(format, true);
  let validate;
  try {
    // Keep bundled pointer targets at their original locations without dereferencing recursive graphs.
    const root = requestSchema({ ...document, ...(typeof schema === 'object' ? schema : {}), ...(schema === false ? { not: {} } : {}) }, document);
    validate = ajv.compile(root as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ApigoError) throw error;
    throw new ApigoError('INVALID_SCHEMA', `Could not validate ${label}: the schema is invalid or unsupported.`, 2, 'Inspect the schema with apigo schema show.');
  }
  if (!validate(value)) {
    const messages = (validate.errors ?? []).slice(0, 6).map(error => `${error.instancePath || '/'} ${error.keyword === 'required' ? `requires ${String(error.params.missingProperty)}` : error.message ?? 'is invalid'}`);
    throw new ApigoError('VALIDATION', `Invalid ${label}: ${messages.join('; ')}.`);
  }
}

export function coerceParameter(value: unknown, schema: Schema, document: Document, name: string): unknown {
  const resolved = resolveSchema(schema, document);
  if (Array.isArray(value) && schemaType(resolved) === 'array') return value.map(item => coerceParameter(item, resolved.items ?? {}, document, name));
  if (typeof value !== 'string') return value;
  switch (schemaType(resolved)) {
    case 'integer': case 'number': {
      if (value.trim() === '' || !Number.isFinite(Number(value))) throw new ApigoError('VALIDATION', `Parameter ${name} must be a number.`);
      return Number(value);
    }
    case 'boolean': {
      if (!['true', 'false'].includes(value)) throw new ApigoError('VALIDATION', `Parameter ${name} must be true or false.`);
      return value === 'true';
    }
    case 'array': {
      let items: unknown;
      if (value.trim().startsWith('[')) {
        try { items = JSON.parse(value); } catch { throw new ApigoError('VALIDATION', `Parameter ${name} must be an array.`); }
      } else items = value.split(',');
      return (items as unknown[]).map(item => coerceParameter(item, resolved.items ?? {}, document, name));
    }
    case 'object': {
      try { return JSON.parse(value); } catch { throw new ApigoError('VALIDATION', `Parameter ${name} must be a JSON object.`); }
    }
    case 'null': return value === 'null' ? null : value;
    default: return value;
  }
}
