import Table from 'cli-table3';
import type { ApiRecord, HistoryEntry, Operation, Schema } from '../core/types.js';
import { resolveSchema, schemaType } from '../openapi/resolver.js';
import { terminalSafe } from '../utils/security.js';
import type { Redactor } from '../utils/security.js';

export function table(head: string[], rows: unknown[][]): string {
  if (!rows.length) return '(none)\n';
  const output = new Table({ head, style: { head: [], border: [], 'padding-left': 0, 'padding-right': 2 },
    chars: { top: '', 'top-mid': '', 'top-left': '', 'top-right': '', bottom: '', 'bottom-mid': '', 'bottom-left': '', 'bottom-right': '', left: '', 'left-mid': '', mid: '', 'mid-mid': '', right: '', 'right-mid': '', middle: '' },
  });
  output.push(...rows.map(row => row.map(value => terminalSafe(String(value ?? '—')))));
  return `${output.toString()}\n`;
}

export function apiSummary(api: ApiRecord) {
  const definition = api.definition;
  return { name: api.name, title: definition.title, kind: definition.kind, specVersion: definition.specVersion, version: definition.version,
    source: definition.source, baseUrl: definition.baseUrl, endpoints: definition.operations.length, schemas: Object.keys(definition.schemas).length };
}

export function renderApi(api: ApiRecord, redactor: Redactor): string {
  const definition = api.definition;
  const lines = [`${definition.kind === 'postman' ? 'Postman' : definition.specVersion === '2.0' ? 'Swagger' : 'OpenAPI'} ${definition.specVersion} detected`,
    `API: ${terminalSafe(redactor.text(definition.title))} (${api.name})`, `Version: ${terminalSafe(definition.version)}`,
    `${definition.operations.length} endpoints · ${Object.keys(definition.schemas).length} schemas`, '', 'Collections'];
  const groups = new Map<string, Operation[]>();
  for (const operation of definition.operations) {
    const group = groups.get(operation.tags[0]!) ?? [];
    group.push(operation);
    groups.set(operation.tags[0]!, group);
  }
  for (const [tag, operations] of groups) {
    lines.push('', `  ${terminalSafe(tag)}`);
    for (const operation of operations) lines.push(`    ${operation.method.padEnd(7)} ${terminalSafe(operation.path).padEnd(36)} ${terminalSafe(operation.key)}${operation.deprecated ? ' (deprecated)' : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderOperation(operation: Operation, api: ApiRecord, redactor: Redactor): string {
  const lines = [`${operation.key}  ${operation.method} ${operation.path}`, operation.summary ?? '', operation.description ?? '',
    `Authentication: ${operation.security.length ? operation.security.map(requirement => Object.keys(requirement).join(' + ') || 'optional').join(' or ') : 'none'}`];
  lines.push('', 'Parameters', table(['NAME', 'IN', 'TYPE', 'REQUIRED', 'DESCRIPTION'], operation.parameters.map(parameter => [parameter.name, parameter.in, schemaType(resolveSchema(parameter.schema, api.definition.document)), parameter.required ? 'yes' : 'no', parameter.description ?? ''])));
  if (operation.requestBody) lines.push(`Request body: ${operation.requestBody.required ? 'required' : 'optional'} (${Object.keys(operation.requestBody.content).join(', ')})`);
  lines.push(`Responses: ${Object.keys(operation.responses).join(', ') || 'not specified'}`);
  return `${terminalSafe(redactor.text(lines.join('\n')))}\n`;
}

export function renderSchema(name: string, schema: Schema, api: ApiRecord): string {
  const resolved = resolveSchema(schema, api.definition.document);
  const rows = Object.entries(resolved.properties ?? {}).map(([key, raw]) => {
    const property = resolveSchema(raw, api.definition.document);
    return [key, schemaType(property) + (property.nullable || Array.isArray(property.type) && property.type.includes('null') ? ' | null' : ''),
      property.format ?? '', resolved.required?.includes(key) ? 'yes' : 'no',
      [property.readOnly ? 'read-only' : '', property.writeOnly ? 'write-only' : '', property.enum ? `enum: ${property.enum.map(String).join(', ')}` : '', property.description ?? ''].filter(Boolean).join('; ')];
  });
  return `${terminalSafe(name)}\n${resolved.description ? `\n${terminalSafe(resolved.description)}\n` : ''}\n${rows.length ? table(['PROPERTY', 'TYPE', 'FORMAT', 'REQUIRED', 'DETAILS'], rows) : `Type: ${schemaType(resolved)}\n`}`;
}

export function renderHistory(entry: HistoryEntry): string {
  let body = entry.response?.body ?? entry.error?.message ?? '';
  try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* Plain or truncated response. */ }
  return `${entry.id}  ${entry.createdAt}\n${entry.request.method} ${terminalSafe(entry.request.url)}\n${entry.recipe.operation ?? ''}\n\n${entry.response ? `${entry.response.status} ${entry.response.statusText} · ${entry.response.timings.totalMs}ms` : entry.error?.code ?? ''}\n\n${terminalSafe(body)}${entry.responseTruncated ? '\n(response truncated at 64 KB)' : ''}\n`;
}
