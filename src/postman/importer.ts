import { readFile, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { ApigoError } from '../core/errors.js';
import type { ApiDefinition, Document, HttpMethod, Operation, RequestOptions, Schema, SecurityScheme } from '../core/types.js';
import { HTTP_METHODS } from '../core/types.js';
import { actionName, nameOperations } from '../core/operation.js';
import { isRecord, record, slug } from '../utils/objects.js';
import { isSensitiveKey } from '../utils/security.js';

const collectionSchema = z.object({ info: z.object({ name: z.string().min(1), schema: z.string().optional() }).passthrough(), item: z.array(z.unknown()), variable: z.array(z.unknown()).optional(), auth: z.unknown().optional() }).passthrough();
export interface PostmanImport { definition: ApiDefinition; variables: Record<string, string>; warnings: string[] }

function inferSchema(value: unknown): Schema {
  if (value === null) return { type: ['string', 'null'] };
  if (Array.isArray(value)) return { type: 'array', items: value.length ? inferSchema(value[0]) : {} };
  if (isRecord(value)) return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inferSchema(item)])) };
  return { type: typeof value === 'number' ? Number.isInteger(value) ? 'integer' : 'number' : typeof value === 'boolean' ? 'boolean' : 'string' };
}

function entries(value: unknown): Record<string, string> {
  return Object.fromEntries((Array.isArray(value) ? value : []).filter(item => isRecord(item) && !item.disabled && typeof item.key === 'string').map(item => [String(record(item).key), String(record(item).value ?? '')]));
}

export function parsePostman(document: Document, source: string): PostmanImport {
  const parsed = collectionSchema.safeParse(document);
  if (!parsed.success) throw new ApigoError('INVALID_POSTMAN', 'Expected a Postman collection with info.name and item entries.');
  const collection = parsed.data;
  if (collection.info.schema && !/collection\/v2\.[01]\.0\//.test(collection.info.schema)) throw new ApigoError('POSTMAN_VERSION', 'Postman collection v2.0 and v2.1 are supported.');
  const variables = entries(collection.variable);
  const warnings = new Set<string>();
  const operations: Operation[] = [];
  const securitySchemes: Record<string, SecurityScheme> = {};
  let defaultBase: string | undefined;

  function protect(name: string, value: string, prefix: string): string {
    if (/\{\{[\w.-]+\}\}/.test(value)) return value;
    const key = `${slug(prefix)}_${slug(name)}`.toUpperCase().replace(/-/g, '_');
    variables[key] = value;
    return `{{${key}}}`;
  }
  function protectBody(value: unknown, prefix: string): unknown {
    if (Array.isArray(value)) return value.map((item, index) => protectBody(item, `${prefix}_${index}`));
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSensitiveKey(key) && typeof item === 'string' ? protect(key, item, prefix) : protectBody(item, `${prefix}_${key}`)]));
  }
  function visit(items: unknown[], folders: string[], inheritedAuth: unknown, depth = 0): void {
    if (depth > 20 || operations.length > 10000) throw new ApigoError('POSTMAN_LIMIT', 'Postman collection exceeds the import complexity limit.');
    for (const item of items) {
      const node = record(item);
      if (node.event) warnings.add('Postman scripts and tests are not executed or converted.');
      const auth = node.auth ?? inheritedAuth;
      if (Array.isArray(node.item)) { visit(node.item, [...folders, String(node.name ?? 'Collection')], auth, depth + 1); continue; }
      const request = typeof node.request === 'string' ? { url: node.request, method: 'GET' } : record(node.request);
      if (!request.url) continue;
      const method = String(request.method ?? 'GET').toUpperCase();
      if (!(HTTP_METHODS as readonly string[]).includes(method)) throw new ApigoError('POSTMAN_METHOD', 'A Postman request uses an unsupported HTTP method.');
      const urlObject = record(request.url);
      let rawUrl = typeof request.url === 'string' ? request.url : typeof urlObject.raw === 'string' ? urlObject.raw :
        `${String(urlObject.protocol ?? 'https')}://${Array.isArray(urlObject.host) ? urlObject.host.join('.') : String(urlObject.host ?? '')}/${Array.isArray(urlObject.path) ? urlObject.path.join('/') : String(urlObject.path ?? '')}`;
      rawUrl = rawUrl.split('#')[0]!;
      const [withoutQuery, queryString] = rawUrl.split('?');
      const match = withoutQuery!.match(/^(https?:\/\/[^/]+|\{\{[\w.-]+\}\})(\/.*)?$/);
      const base = match?.[1] ?? '{{BASE_URL}}';
      let path = match?.[2] ?? (withoutQuery!.startsWith('/') ? withoutQuery! : '/');
      const preset: RequestOptions = { headers: entries(request.header), query: { ...Object.fromEntries(new URLSearchParams(queryString)), ...entries(urlObject.query) }, params: {} };
      const parameterValues = entries(urlObject.variable);
      const parameters = [];
      path = path.replace(/:([A-Za-z_][\w-]*)/g, (_match, name: string) => {
        parameters.push({ name, in: 'path' as const, required: true, schema: { type: 'string' } });
        if (parameterValues[name]) preset.params![name] = parameterValues[name];
        return `{${name}}`;
      });
      const tags = [folders.at(-1) ?? collection.info.name];
      const group = slug(tags[0]!); const operationId = String(node.name ?? `${method} ${path}`);
      const key = `${group}.${actionName(operationId, group, method as HttpMethod, path)}`;
      const prefix = `${group}_${operations.length + 1}`;
      for (const [name, value] of Object.entries(preset.headers!)) if (isSensitiveKey(name)) preset.headers![name] = protect(name, value, prefix);
      for (const [name, value] of Object.entries(preset.query!)) if (isSensitiveKey(name)) preset.query![name] = protect(name, String(value), prefix);

      const security: Record<string, string[]>[] = [];
      const effectiveAuth = record(request.auth ?? auth);
      const authType = effectiveAuth.type;
      const authValues = entries(effectiveAuth[String(authType)]);
      if (authType === 'bearer' || authType === 'oauth2') {
        securitySchemes.PostmanBearer = { type: 'http', scheme: 'bearer' }; security.push({ PostmanBearer: [] });
        const token = authValues.token ?? authValues.accessToken;
        if (token) preset.headers!.Authorization = `Bearer ${protect('TOKEN', token, prefix)}`;
      } else if (authType === 'basic') {
        securitySchemes.PostmanBasic = { type: 'http', scheme: 'basic' }; security.push({ PostmanBasic: [] });
        if (![authValues.username, authValues.password].some(value => value?.includes('{{'))) {
          preset.headers!.Authorization = protect('AUTHORIZATION', `Basic ${Buffer.from(`${authValues.username ?? ''}:${authValues.password ?? ''}`).toString('base64')}`, prefix);
        } else warnings.add('Basic authentication with variable references requires apigo auth set basic.');
      } else if (authType === 'apikey') {
        const name = authValues.key ?? 'X-API-Key'; const location = authValues.in === 'query' ? 'query' : 'header';
        const scheme = `PostmanApiKey${operations.length + 1}`;
        securitySchemes[scheme] = { type: 'apiKey', name, in: location }; security.push({ [scheme]: [] });
        const value = protect(name, authValues.value ?? '', prefix);
        if (location === 'header') preset.headers![name] = value; else preset.query![name] = value;
      } else if (authType && authType !== 'noauth') warnings.add(`Postman ${String(authType)} authentication requires manual configuration.`);

      const body = record(request.body);
      let bodySchema: Schema | undefined;
      if (body.mode === 'raw') {
        let value: unknown = String(body.raw ?? '');
        let parsedJson = false;
        try { value = JSON.parse(String(body.raw)); parsedJson = true; } catch { /* Plain text or a body containing Postman variables. */ }
        preset.body = protectBody(value, prefix);
        preset.contentType = Object.entries(preset.headers!).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? (record(record(body.options).raw).language === 'json' || typeof value !== 'string' ? 'application/json' : 'text/plain');
        bodySchema = inferSchema(value);
        if (typeof value === 'string' && preset.contentType.includes('json')) {
          if (parsedJson) preset.body = JSON.stringify(value);
          else bodySchema = {};
        }
      } else if (body.mode === 'urlencoded') {
        preset.body = protectBody(entries(body.urlencoded), prefix); preset.contentType = 'application/x-www-form-urlencoded'; bodySchema = inferSchema(preset.body);
      } else if (body.mode && body.mode !== 'raw') throw new ApigoError('POSTMAN_BODY', 'Postman import currently supports raw and URL-encoded bodies.');
      for (const [name, value] of Object.entries(preset.query!)) parameters.push({ name, in: 'query' as const, required: false, schema: { type: 'string', default: value } });
      defaultBase ??= base;
      operations.push({ key, aliases: [], operationId, tags, group, method: method as HttpMethod, path,
        parameters, responses: {}, security, servers: [base], deprecated: false, preset,
        ...(bodySchema === undefined ? {} : { requestBody: { required: true, content: { [preset.contentType!]: { schema: bodySchema, example: preset.body } } } }),
        summary: operationId, description: typeof request.description === 'string' ? request.description : undefined,
      });
    }
  }
  if (collection.event) warnings.add('Postman scripts and tests are not executed or converted.');
  visit(collection.item, [], collection.auth);
  if (!operations.length) throw new ApigoError('EMPTY_POSTMAN', 'The Postman collection contains no supported HTTP requests.');
  nameOperations(operations);
  for (const key of Object.keys(variables)) if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new ApigoError('POSTMAN_VARIABLE', 'Postman variables must have names compatible with apigo environments.');
  const definition: ApiDefinition = { kind: 'postman', title: collection.info.name, version: '1', specVersion: '2.1', source,
    baseUrl: defaultBase, operations, schemas: {}, securitySchemes,
    document: { openapi: '3.1.0', info: { title: collection.info.name, version: '1' }, paths: {}, components: { securitySchemes } } };
  return { definition, variables, warnings: [...warnings] };
}

export async function loadPostman(source: string): Promise<PostmanImport> {
  let document: unknown; let path: string;
  try {
    path = await realpath(source);
    const info = await stat(path);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new ApigoError('POSTMAN_SIZE', 'Postman source must be a file no larger than 10 MB.');
    document = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error instanceof ApigoError) throw error; throw new ApigoError('INVALID_POSTMAN', 'Could not read a valid Postman JSON collection.'); }
  if (!isRecord(document)) throw new ApigoError('INVALID_POSTMAN', 'Expected a Postman collection object.');
  return parsePostman(document, path);
}
