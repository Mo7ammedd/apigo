import { z } from 'zod';
import { ApigoError } from '../core/errors.js';
import type { ApiDefinition, Document, MediaType, Operation, Parameter, RequestBody, Schema, SecurityRequirement, SecurityScheme } from '../core/types.js';
import { HTTP_METHODS } from '../core/types.js';
import { actionName, nameOperations } from '../core/operation.js';
import { isRecord, record, slug, strings } from '../utils/objects.js';
import { asSchema, resolveNode } from './resolver.js';

const rootSchema = z.object({
  info: z.object({ title: z.string().min(1), version: z.string() }).passthrough(),
  paths: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

function security(value: unknown): SecurityRequirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => !isRecord(item) || Object.values(item).some(scopes => !Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string')))) {
    throw new ApigoError('INVALID_SPEC', 'Security requirements must be an array of scheme-to-scope mappings.');
  }
  return value as SecurityRequirement[];
}

function serverUrls(value: unknown, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApigoError('INVALID_SPEC', 'OpenAPI servers must be an array.');
  return value.flatMap(item => {
    const server = record(item);
    if (typeof server.url !== 'string') throw new ApigoError('INVALID_SPEC', 'An OpenAPI server is missing its URL.');
    const variables = record(server.variables);
    const url = server.url.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const definition = record(variables[name]);
      if (definition.default === undefined) throw new ApigoError('INVALID_SPEC', 'Server variables must define defaults.');
      return String(definition.default);
    });
    if (/^https?:\/\//i.test(url)) return [url.replace(/\/$/, '')];
    if (/^https?:\/\//i.test(source)) return [new URL(url, source).toString().replace(/\/$/, '')];
    return [url];
  });
}

function parseParameter(value: unknown, document: Document, swagger: boolean): Parameter {
  const item = resolveNode(value, document);
  if (typeof item.name !== 'string' || !item.name || !['path', 'query', 'header', 'cookie'].includes(String(item.in))) throw new ApigoError('INVALID_SPEC', 'A parameter has an invalid name or location.');
  const content = record(item.content);
  const contentType = Object.keys(content)[0];
  const media = record(contentType ? content[contentType] : undefined);
  const schema = item.schema ?? media.schema ?? (swagger ? Object.fromEntries(['type', 'format', 'items', 'enum', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern'].filter(key => item[key] !== undefined).map(key => [key, item[key]])) : {});
  const examples = record(item.examples);
  const firstExample = resolveNode(Object.values(examples)[0], document).value;
  return {
    name: item.name, in: item.in as Parameter['in'], required: item.in === 'path' || item.required === true,
    schema: asSchema(schema),
    ...(typeof item.description === 'string' ? { description: item.description } : {}),
    ...(item.example !== undefined || firstExample !== undefined ? { example: item.example ?? firstExample } : {}),
    ...(typeof item.style === 'string' ? { style: item.style } : {}),
    ...(typeof item.explode === 'boolean' ? { explode: item.explode } : {}),
    ...(typeof item.allowReserved === 'boolean' ? { allowReserved: item.allowReserved } : {}),
    ...(typeof item.collectionFormat === 'string' ? { collectionFormat: item.collectionFormat } : {}),
    ...(contentType ? { contentType } : {}),
  };
}

function mediaContent(value: unknown, document: Document): Record<string, MediaType> {
  return Object.fromEntries(Object.entries(record(value)).map(([type, content]) => {
    const media = record(content);
    const examples = Object.fromEntries(Object.entries(record(media.examples)).map(([key, example]) => [key, resolveNode(example, document)]));
    return [type, { ...media, ...(media.schema === undefined ? {} : { schema: asSchema(media.schema) }), ...(Object.keys(examples).length ? { examples } : {}) } as MediaType];
  }));
}

function requestBody(operation: Document, parameters: Document[], document: Document, swagger: boolean): RequestBody | undefined {
  if (!swagger) {
    if (operation.requestBody === undefined) return undefined;
    const body = resolveNode(operation.requestBody, document);
    if (!isRecord(body.content) || !Object.keys(body.content).length) throw new ApigoError('INVALID_SPEC', 'A request body must define at least one media type.');
    return { required: body.required === true, description: typeof body.description === 'string' ? body.description : undefined, content: mediaContent(body.content, document) };
  }
  const body = parameters.find(parameter => parameter.in === 'body');
  const consumes = strings(operation.consumes ?? document.consumes);
  if (body) return { required: body.required === true, content: Object.fromEntries((consumes.length ? consumes : ['application/json']).map(type => [type, { schema: asSchema(body.schema) }])) };
  const form = parameters.filter(parameter => parameter.in === 'formData');
  if (!form.length) return undefined;
  return {
    required: form.some(parameter => parameter.required === true),
    content: Object.fromEntries((consumes.length ? consumes : ['application/x-www-form-urlencoded']).map(type => [type, {
      schema: { type: 'object', properties: Object.fromEntries(form.map(parameter => [String(parameter.name), { ...parameter, type: typeof parameter.type === 'string' && parameter.type !== 'file' ? parameter.type : 'string', ...(parameter.type === 'file' ? { format: 'binary' } : {}) }])), required: form.filter(parameter => parameter.required === true).map(parameter => String(parameter.name)) },
    }])),
  };
}

function responses(value: unknown, document: Document, swagger: boolean, produces: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record(value)).map(([status, raw]) => {
    const response = resolveNode(raw, document);
    if (!swagger) return [status, { ...response, ...(response.content ? { content: mediaContent(response.content, document) } : {}) }];
    const types = produces.length ? produces : ['application/json'];
    return [status, { description: response.description, headers: response.headers, content: Object.fromEntries(types.map(type => [type, { schema: response.schema, example: record(response.examples)[type] }])) }];
  }));
}

export function parseOpenApi(document: Document, source: string): ApiDefinition {
  const version = document.openapi ?? document.swagger;
  if (typeof version !== 'string' || !/^(3\.[01]\.\d+|2\.0)$/.test(version)) {
    throw new ApigoError('UNSUPPORTED_SPEC', 'Expected OpenAPI 3.0, OpenAPI 3.1, or Swagger 2.0.');
  }
  const parsed = rootSchema.safeParse(document);
  if (!parsed.success) throw new ApigoError('INVALID_SPEC', 'The specification needs info.title, info.version, and a valid paths object.');
  const swagger = version === '2.0';
  if (!version.startsWith('3.1.') && document.paths === undefined) throw new ApigoError('INVALID_SPEC', 'This specification version requires a paths object.');
  if (document.components !== undefined && !isRecord(document.components)) throw new ApigoError('INVALID_SPEC', 'OpenAPI components must be an object.');
  const components = record(document.components);
  for (const field of [swagger ? document.definitions : components.schemas, swagger ? document.securityDefinitions : components.securitySchemes]) {
    if (field !== undefined && !isRecord(field)) throw new ApigoError('INVALID_SPEC', 'Schemas and security schemes must be objects.');
  }
  const schemas = record(swagger ? document.definitions : components.schemas) as Record<string, Schema>;
  const schemes = record(swagger ? document.securityDefinitions : components.securitySchemes);
  const securitySchemes: Record<string, SecurityScheme> = Object.fromEntries(Object.entries(schemes).map(([name, raw]) => {
    const scheme = resolveNode(raw, document);
    if (swagger && scheme.type === 'basic') return [name, { type: 'http', scheme: 'basic' }];
    if (swagger && scheme.type === 'oauth2') return [name, { type: 'oauth2', flows: { [String(scheme.flow)]: { authorizationUrl: scheme.authorizationUrl, tokenUrl: scheme.tokenUrl, scopes: scheme.scopes } } }];
    if (!['http', 'apiKey', 'oauth2', 'openIdConnect', 'mutualTLS'].includes(String(scheme.type)) ||
      scheme.type === 'http' && (typeof scheme.scheme !== 'string' || !scheme.scheme) ||
      scheme.type === 'apiKey' && (typeof scheme.name !== 'string' || !scheme.name || !['header', 'query', 'cookie'].includes(String(scheme.in))) ||
      scheme.type === 'oauth2' && !isRecord(scheme.flows)) {
      throw new ApigoError('INVALID_SPEC', 'A security scheme has an invalid type or missing configuration.');
    }
    return [name, scheme as unknown as SecurityScheme];
  }));
  let servers = serverUrls(document.servers, source);
  if (swagger) {
    const scheme = strings(document.schemes)[0] ?? (/^https:/i.test(source) ? 'https' : 'http');
    const host = typeof document.host === 'string' ? document.host : /^https?:\/\//i.test(source) ? new URL(source).host : undefined;
    servers = host ? [`${scheme}://${host}${typeof document.basePath === 'string' ? document.basePath : ''}`.replace(/\/$/, '')] : [];
  }
  if (!servers.length && /^https?:\/\//i.test(source)) servers = [new URL(source).origin];
  const operations: Operation[] = [];
  for (const [path, rawPath] of Object.entries(record(document.paths))) {
    if (path.startsWith('x-')) continue;
    if (!path.startsWith('/')) throw new ApigoError('INVALID_SPEC', 'OpenAPI paths must begin with /.');
    if (!isRecord(rawPath)) throw new ApigoError('INVALID_SPEC', 'OpenAPI path items must be objects.');
    const pathItem = resolveNode(rawPath, document);
    if (pathItem.parameters !== undefined && !Array.isArray(pathItem.parameters)) throw new ApigoError('INVALID_SPEC', 'Path parameters must be an array.');
    for (const method of HTTP_METHODS) {
      const raw = pathItem[method.toLowerCase()];
      if (raw === undefined) continue;
      if (!isRecord(raw)) throw new ApigoError('INVALID_SPEC', 'OpenAPI operations must be objects.');
      if (raw.parameters !== undefined && !Array.isArray(raw.parameters)) throw new ApigoError('INVALID_SPEC', 'Operation parameters must be an array.');
      if (!isRecord(raw.responses)) throw new ApigoError('INVALID_SPEC', 'An operation must define a responses object.');
      if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.some(tag => typeof tag !== 'string'))) throw new ApigoError('INVALID_SPEC', 'Operation tags must be an array of strings.');
      const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
      const operationParameters = Array.isArray(raw.parameters) ? raw.parameters : [];
      const merged = new Map<string, Document>();
      for (const parameter of [...pathParameters, ...operationParameters]) {
        const item = resolveNode(parameter, document);
        merged.set(`${String(item.in)}:${String(item.name)}`, item);
      }
      const allParameters = [...merged.values()];
      const parameters = allParameters.filter(item => !swagger || !['body', 'formData'].includes(String(item.in))).map(item => parseParameter(item, document, swagger));
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        if (!parameters.some(parameter => parameter.in === 'path' && parameter.name === match[1])) throw new ApigoError('INVALID_SPEC', 'A path template is missing its path parameter definition.');
      }
      const tags = strings(raw.tags);
      if (!tags.length) tags.push(path.split('/').find(part => part && !/^api$|^v\d+$|^\{/.test(part)) ?? 'default');
      const group = slug(tags[0]!);
      const operationId = typeof raw.operationId === 'string' ? raw.operationId : undefined;
      const operationServers = swagger ? servers : serverUrls(raw.servers ?? pathItem.servers ?? document.servers, source);
      const operationSecurity = security(raw.security ?? document.security);
      for (const requirement of operationSecurity) for (const name of Object.keys(requirement)) {
        if (!Object.hasOwn(securitySchemes, name)) throw new ApigoError('INVALID_SPEC', 'An operation references an undefined security scheme.');
      }
      operations.push({
        key: `${group}.${actionName(operationId, group, method, path)}`, aliases: [], operationId,
        tags, group, method, path, summary: typeof raw.summary === 'string' ? raw.summary : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        parameters, requestBody: requestBody(raw, allParameters, document, swagger),
        responses: responses(raw.responses, document, swagger, strings(raw.produces ?? document.produces)),
        security: operationSecurity, servers: operationServers.length ? operationServers : servers,
        deprecated: raw.deprecated === true,
      });
    }
  }
  nameOperations(operations);
  return { kind: 'openapi', title: parsed.data.info.title, version: parsed.data.info.version, specVersion: version,
    source, baseUrl: servers[0], document, operations, schemas, securitySchemes };
}
