import { writeFile } from 'node:fs/promises';
import { ApigoError } from '../core/errors.js';
import type { ApiDefinition, Operation } from '../core/types.js';
import { generateBody, mediaExample } from '../openapi/generator.js';
import { resolveSchema } from '../openapi/resolver.js';
import { isRecord } from '../utils/objects.js';
import { isSensitiveKey, Redactor } from '../utils/security.js';

export function exportPostman(api: ApiDefinition): Record<string, unknown> {
  const redactor = new Redactor();
  const variables: Record<string, string> = { BASE_URL: api.baseUrl && !api.baseUrl.includes('{{') ? api.baseUrl : '' };
  const sensitiveNames = new Set(Object.values(api.securitySchemes).map(scheme => scheme.name?.toLowerCase()).filter((name): name is string => Boolean(name)));
  const sensitive = (name: string): boolean => isSensitiveKey(name) || sensitiveNames.has(name.toLowerCase());
  const placeholder = (name: string): string => {
    const key = name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    variables[key] ??= '';
    return `{{${key}}}`;
  };
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (typeof value === 'string') {
      try { return JSON.stringify(clean(JSON.parse(value))); } catch { return redactor.text(value); }
    }
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sensitive(key) ? placeholder(key) : clean(child)]));
  };
  const safeUrl = (value: string): string => {
    if (!value) return value;
    const templates: string[] = [];
    const masked = value.replace(/\{\{[^{}]+\}\}/g, match => { templates.push(match); return `apigo-template-${templates.length - 1}`; });
    try {
      const absolute = /^https?:\/\//i.test(masked);
      const url = new URL(masked, 'https://apigo-export.invalid/'); url.username = ''; url.password = '';
      for (const key of [...url.searchParams.keys()]) if (sensitive(key)) url.searchParams.set(key, placeholder(key));
      const result = absolute ? url.toString() : `${masked.startsWith('/') ? url.pathname : url.pathname.slice(1)}${url.search}`;
      return result.replace(/apigo-template-(\d+)/g, (_match, index: string) => templates[Number(index)]!)
        .replace(/%7B%7B[\w.-]+%7D%7D/gi, match => decodeURIComponent(match)).replace(/\/$/, '');
    } catch { return redactor.text(value); }
  };
  variables.BASE_URL = safeUrl(variables.BASE_URL!);
  const groups = new Map<string, unknown[]>();
  for (const operation of api.operations) {
    const headers: { key: string; value: string }[] = Object.entries(operation.preset?.headers ?? {}).map(([key, value]) => ({ key, value: sensitive(key) ? placeholder(key) : redactor.text(value) }));
    const query: { key: string; value: string }[] = [];
    const pathVariables: { key: string; value: string }[] = [];
    for (const parameter of operation.parameters) {
      const schema = resolveSchema(parameter.schema, api.document);
      const value = sensitive(parameter.name) ? placeholder(parameter.name) : String(operation.preset?.query?.[parameter.name] ?? schema.default ?? parameter.example ?? `{{${parameter.name}}}`);
      if (parameter.in === 'query') query.push({ key: parameter.name, value });
      if (parameter.in === 'path') pathVariables.push({ key: parameter.name, value: String(operation.preset?.params?.[parameter.name] ?? '') });
      if (parameter.in === 'header' && !headers.some(header => header.key.toLowerCase() === parameter.name.toLowerCase())) headers.push({ key: parameter.name, value });
    }
    const base = operation.servers[0] && operation.servers[0] !== api.baseUrl ? safeUrl(operation.servers[0]) : '{{BASE_URL}}';
    const path = operation.path.replace(/\{([^}]+)\}/g, ':$1');
    const rawUrl = `${base}${path}${query.length ? `?${query.map(item => `${encodeURIComponent(item.key)}=${item.value}`).join('&')}` : ''}`;
    const request: Record<string, unknown> = { method: operation.method, header: headers, url: { raw: rawUrl, query, variable: pathVariables }, description: operation.description ?? operation.summary ?? '' };
    if (operation.requestBody) {
      const type = operation.preset?.contentType ?? Object.keys(operation.requestBody.content).find(type => type.includes('json')) ?? Object.keys(operation.requestBody.content)[0]!;
      const media = operation.requestBody.content[type];
      const schema = resolveSchema(media?.schema ?? {}, api.document);
      let example = operation.preset?.body ?? mediaExample(media) ?? generateBody(media?.schema ?? {}, api.document);
      if (operation.preset?.body !== undefined && typeof example === 'string' && type.includes('json')) {
        try { example = JSON.parse(example); } catch { /* Imported plain text is preserved as a JSON string. */ }
      }
      const body = schema.writeOnly || schema.format === 'password' ? placeholder('BODY_SECRET') : clean(example);
      if (type === 'application/x-www-form-urlencoded' && isRecord(body)) request.body = { mode: 'urlencoded', urlencoded: Object.entries(body).map(([key, value]) => ({ key, value: String(value), type: 'text' })) };
      else request.body = { mode: 'raw', raw: type.includes('json') || typeof body !== 'string' ? JSON.stringify(body, null, 2) : body, options: { raw: { language: type.includes('json') ? 'json' : 'text' } } };
      if (!headers.some(header => header.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: type });
    }
    const auth = exportAuth(operation, api, placeholder);
    if (auth) request.auth = auth;
    const tag = operation.tags[0] ?? 'Default'; const items = groups.get(tag) ?? [];
    items.push({ name: operation.key, request, response: [] }); groups.set(tag, items);
  }
  return {
    info: { name: api.title, description: 'Exported by apigo. Configure credential placeholders before sending requests.', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [...groups].map(([name, item]) => ({ name, item })),
    variable: Object.entries(variables).map(([key, value]) => ({ key, value, type: 'string' })),
  };
}

function exportAuth(operation: Operation, api: ApiDefinition, placeholder: (name: string) => string): unknown {
  const requirement = operation.security.find(item => Object.keys(item).length);
  if (!requirement) return { type: 'noauth' };
  const name = Object.keys(requirement)[0]!; const scheme = api.securitySchemes[name];
  if (!scheme) return undefined;
  if (scheme.type === 'apiKey') return { type: 'apikey', apikey: [{ key: 'key', value: scheme.name, type: 'string' }, { key: 'value', value: placeholder(scheme.name ?? 'API_KEY'), type: 'string' }, { key: 'in', value: scheme.in ?? 'header', type: 'string' }] };
  if (scheme.scheme?.toLowerCase() === 'basic') return { type: 'basic', basic: [{ key: 'username', value: placeholder('USERNAME'), type: 'string' }, { key: 'password', value: placeholder('PASSWORD'), type: 'string' }] };
  return { type: 'bearer', bearer: [{ key: 'token', value: placeholder('TOKEN'), type: 'string' }] };
}

export async function writePostman(api: ApiDefinition, path: string, force = false): Promise<void> {
  try { await writeFile(path, `${JSON.stringify(exportPostman(api), null, 2)}\n`, { flag: force ? 'w' : 'wx', mode: 0o600 }); }
  catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') throw new ApigoError('FILE_EXISTS', 'The export file already exists.', 2, 'Use --force to replace it.');
    throw new ApigoError('FILE_WRITE', 'Could not write the Postman export.');
  }
}
