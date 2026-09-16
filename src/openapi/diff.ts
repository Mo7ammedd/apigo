import type { ApiDefinition, ApiDiff, DiffChange, Document, Operation, Schema } from '../core/types.js';
import { record, stableStringify } from '../utils/objects.js';
import { asSchema, resolveSchema } from './resolver.js';

const equal = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);
const change = (message: string, breaking = false): DiffChange => ({ message, breaking });

export function schemaChanges(before: Schema, after: Schema, oldDocument: Document, newDocument: Document, prefix = '', depth = 0, seen = new Set<string>()): DiffChange[] {
  if (depth > 8) return [];
  if (typeof before === 'boolean' || typeof after === 'boolean') return equal(before, after) ? [] : [change(`${prefix || 'schema'} acceptance changed`, after === false || before === true)];
  const identity = before.$ref && after.$ref ? `${before.$ref}|${after.$ref}` : undefined;
  if (identity && seen.has(identity)) return [];
  const nextSeen = new Set(seen); if (identity) nextSeen.add(identity);
  const old = resolveSchema(before, oldDocument); const next = resolveSchema(after, newDocument);
  const changes: DiffChange[] = [];
  const field = (name: string): string => prefix ? `${prefix}.${name}` : name;
  const oldProperties = old.properties ?? {}; const newProperties = next.properties ?? {};
  for (const [name, schema] of Object.entries(newProperties)) {
    if (!Object.hasOwn(oldProperties, name)) changes.push(change(`+ ${field(name)}${next.required?.includes(name) ? ' (required)' : ''}`, next.required?.includes(name) ?? false));
    else changes.push(...schemaChanges(oldProperties[name]!, schema, oldDocument, newDocument, field(name), depth + 1, nextSeen));
  }
  for (const name of Object.keys(oldProperties)) if (!Object.hasOwn(newProperties, name)) changes.push(change(`- ${field(name)}`, true));
  for (const name of next.required ?? []) if (!old.required?.includes(name) && Object.hasOwn(oldProperties, name)) changes.push(change(`${field(name)} is now required`, true));
  for (const name of old.required ?? []) if (!next.required?.includes(name) && Object.hasOwn(newProperties, name)) changes.push(change(`${field(name)} is no longer required`, true));
  if (old.items !== undefined && next.items !== undefined) changes.push(...schemaChanges(old.items, next.items, oldDocument, newDocument, `${prefix}[]`, depth + 1, nextSeen));
  else if (!equal(old.items, next.items)) changes.push(change(`${prefix || 'schema'} array items changed`, true));
  const handled = new Set(['properties', 'required', 'items', '$ref', 'allOf']);
  const docs = new Set(['description', 'title', 'example', 'examples', 'default', 'deprecated', 'externalDocs', 'xml']);
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (handled.has(key) || equal(old[key], next[key])) continue;
    let breaking = !docs.has(key);
    if (key === 'enum' && Array.isArray(old.enum) && Array.isArray(next.enum)) breaking = old.enum.some(item => !next.enum!.some(other => equal(item, other)));
    if (['minimum', 'minLength', 'minItems', 'minProperties'].includes(key)) breaking = typeof next[key] === 'number' && (typeof old[key] !== 'number' || Number(next[key]) > Number(old[key]));
    if (['maximum', 'maxLength', 'maxItems', 'maxProperties'].includes(key)) breaking = typeof next[key] === 'number' && (typeof old[key] !== 'number' || Number(next[key]) < Number(old[key]));
    if (key === 'nullable') breaking = next[key] !== true;
    changes.push(change(`${prefix || 'schema'} ${key} changed`, breaking));
  }
  return changes;
}

function operationChanges(old: Operation, next: Operation, before: ApiDefinition, after: ApiDefinition): DiffChange[] {
  const changes: DiffChange[] = [];
  const oldParameters = new Map(old.parameters.map(item => [`${item.in}:${item.name}`, item]));
  const newParameters = new Map(next.parameters.map(item => [`${item.in}:${item.name}`, item]));
  for (const [key, parameter] of newParameters) {
    const previous = oldParameters.get(key);
    const label = `${parameter.name} ${parameter.in} parameter`;
    if (!previous) { changes.push(change(`+ ${label}${parameter.required ? ' (required)' : ''}`, parameter.required)); continue; }
    if (previous.required !== parameter.required) changes.push(change(`${label} is ${parameter.required ? 'now required' : 'now optional'}`, parameter.required));
    changes.push(...schemaChanges(previous.schema, parameter.schema, before.document, after.document, label));
    for (const field of ['style', 'explode', 'collectionFormat', 'contentType'] as const) if (!equal(previous[field], parameter[field])) changes.push(change(`${label} ${field} changed`, true));
  }
  for (const [key, parameter] of oldParameters) if (!newParameters.has(key)) changes.push(change(`- ${parameter.name} ${parameter.in} parameter`, true));
  if (old.key !== next.key) changes.push(change(`operation name changed: ${old.key} → ${next.key}`, true));
  if (!equal(old.security, next.security)) changes.push(change('authentication requirements changed', next.security.length > 0 && !next.security.some(item => Object.keys(item).length === 0)));
  if (Boolean(old.requestBody?.required) !== Boolean(next.requestBody?.required)) changes.push(change(`request body is ${next.requestBody?.required ? 'now required' : 'now optional'}`, next.requestBody?.required ?? false));
  const oldContent = old.requestBody?.content ?? {}; const newContent = next.requestBody?.content ?? {};
  for (const [type, media] of Object.entries(newContent)) {
    if (!oldContent[type]) changes.push(change(`+ ${type} request body`));
    else changes.push(...schemaChanges(oldContent[type]!.schema ?? {}, media.schema ?? {}, before.document, after.document, `${type} body`));
  }
  for (const type of Object.keys(oldContent)) if (!newContent[type]) changes.push(change(`- ${type} request body`, true));
  for (const [status, value] of Object.entries(next.responses)) {
    if (!old.responses[status]) { changes.push(change(`+ ${status} response`)); continue; }
    const oldResponseContent = record(record(old.responses[status]).content); const newResponseContent = record(record(value).content);
    for (const [type, media] of Object.entries(newResponseContent)) {
      if (!oldResponseContent[type]) changes.push(change(`+ ${status} ${type} response`));
      else changes.push(...schemaChanges(asSchema(record(oldResponseContent[type]).schema), asSchema(record(media).schema), before.document, after.document, `${status} response`));
    }
    for (const type of Object.keys(oldResponseContent)) if (!newResponseContent[type]) changes.push(change(`- ${status} ${type} response`, true));
  }
  for (const status of Object.keys(old.responses)) if (!next.responses[status]) changes.push(change(`- ${status} response`, true));
  if (!equal(old.servers, next.servers)) changes.push(change('operation servers changed', true));
  if (old.deprecated !== next.deprecated) changes.push(change(next.deprecated ? 'operation deprecated' : 'deprecation removed'));
  if (old.summary !== next.summary || old.description !== next.description) changes.push(change('documentation changed'));
  return changes;
}

export function diffApis(before: ApiDefinition, after: ApiDefinition): ApiDiff {
  const result: ApiDiff = { addedOperations: [], removedOperations: [], changedOperations: [], addedSchemas: [], removedSchemas: [], changedSchemas: [], changes: [], breaking: false };
  const oldOperations = new Map(before.operations.map(operation => [`${operation.method} ${operation.path}`, operation]));
  const newOperations = new Map(after.operations.map(operation => [`${operation.method} ${operation.path}`, operation]));
  for (const [name, operation] of newOperations) {
    const old = oldOperations.get(name);
    if (!old) result.addedOperations.push(name);
    else { const changes = operationChanges(old, operation, before, after); if (changes.length) result.changedOperations.push({ name, changes }); }
  }
  for (const name of oldOperations.keys()) if (!newOperations.has(name)) result.removedOperations.push(name);
  for (const [name, schema] of Object.entries(after.schemas)) {
    if (!Object.hasOwn(before.schemas, name)) result.addedSchemas.push(name);
    else { const changes = schemaChanges(before.schemas[name]!, schema, before.document, after.document); if (changes.length) result.changedSchemas.push({ name, changes }); }
  }
  for (const name of Object.keys(before.schemas)) if (!Object.hasOwn(after.schemas, name)) result.removedSchemas.push(name);
  if (before.version !== after.version) result.changes.push(change(`API version changed: ${before.version} → ${after.version}`));
  if (before.specVersion !== after.specVersion) result.changes.push(change(`Specification version changed: ${before.specVersion} → ${after.specVersion}`));
  if (!equal(before.securitySchemes, after.securitySchemes)) result.changes.push(change('Security scheme configuration changed', true));
  if (before.baseUrl !== after.baseUrl) result.changes.push(change('Default server URL changed', true));
  result.breaking = Boolean(result.removedOperations.length || result.removedSchemas.length || [...result.changedOperations, ...result.changedSchemas].some(item => item.changes.some(change => change.breaking)) || result.changes.some(change => change.breaking));
  return result;
}

export function hasChanges(diff: ApiDiff): boolean {
  return Boolean(diff.addedOperations.length || diff.removedOperations.length || diff.changedOperations.length || diff.addedSchemas.length || diff.removedSchemas.length || diff.changedSchemas.length || diff.changes.length);
}
