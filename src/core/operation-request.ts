import { ApigoError } from './errors.js';
import type { ApiDefinition, Operation, PreparedRequest, PromptAdapter, RequestOptions } from './types.js';
import type { Variables } from '../environments/interpolation.js';
import { interpolate } from '../environments/interpolation.js';
import { generateBody, mediaExample, requestExample } from '../openapi/generator.js';
import { resolveSchema } from '../openapi/resolver.js';
import { coerceParameter, validateValue } from '../openapi/validation.js';
import { headerValue, pathValue, queryValues } from '../openapi/serialization.js';
import { mergeOptions, normalizeHeaders, prepareHttp } from './request.js';
import { containsRedaction, parseJson } from '../utils/objects.js';

export interface BuildResult { request: PreparedRequest; options: RequestOptions; prompted: boolean }

export async function prepareOperation(api: ApiDefinition, operation: Operation, overrides: RequestOptions, variables: Variables = {}, prompts?: PromptAdapter): Promise<BuildResult> {
  const template = mergeOptions(operation.preset ?? {}, overrides);
  const options = interpolate(template, variables);
  const supplied = interpolate(overrides, variables);
  const suppliedHeaders = normalizeHeaders(supplied.headers);
  const headers = normalizeHeaders(options.headers);
  const query: [string, string][] = [];
  const consumed = new Set<string>();
  const optionsToSave = structuredClone(overrides);
  optionsToSave.values ??= {};
  let path = operation.path;
  let prompted = false;
  const missing: string[] = [];
  for (const parameter of operation.parameters) {
    const resolved = resolveSchema(parameter.schema, api.document);
    const sameName = operation.parameters.filter(item => item.name === parameter.name);
    const dynamic = options.values?.[parameter.name];
    if (dynamic !== undefined && sameName.length > 1) throw new ApigoError('AMBIGUOUS_PARAMETER', `Parameter ${parameter.name} appears in multiple locations.`, 2, 'Use -p, -q, or -H to specify its location.');
    const explicit = parameter.in === 'path' ? options.params?.[parameter.name] : parameter.in === 'query' ? options.query?.[parameter.name] : parameter.in === 'header' ? headers[parameter.name.toLowerCase()] : undefined;
    const explicitOverride = parameter.in === 'path' ? supplied.params?.[parameter.name] : parameter.in === 'query' ? supplied.query?.[parameter.name] : parameter.in === 'header' ? suppliedHeaders[parameter.name.toLowerCase()] : undefined;
    let value = explicitOverride ?? dynamic ?? explicit ?? resolved.default;
    if (dynamic !== undefined) consumed.add(parameter.name);
    if (value === undefined && parameter.required && prompts) {
      value = await prompts.parameter(parameter, resolved);
      optionsToSave.values[parameter.name] = value;
      prompted = true;
    }
    if (value === undefined) { if (parameter.required) missing.push(`--${parameter.name}`); continue; }
    value = coerceParameter(value, parameter.schema, api.document, parameter.name);
    validateValue(value, parameter.schema, api.document, `parameter ${parameter.name}`);
    if (parameter.in === 'path') path = path.replaceAll(`{${parameter.name}}`, pathValue(parameter, value));
    else if (parameter.in === 'query') query.push(...queryValues(parameter, value));
    else if (parameter.in === 'header') headers[parameter.name.toLowerCase()] = headerValue(parameter, value);
    else headers.cookie = [headers.cookie, `${encodeURIComponent(parameter.name)}=${encodeURIComponent(headerValue(parameter, value))}`].filter(Boolean).join('; ');
  }
  if (missing.length) throw new ApigoError('MISSING_PARAMETERS', `Missing required parameters: ${missing.join(', ')}.`, 2, 'Pass values explicitly in CI, or run from an interactive terminal.');
  for (const name of Object.keys(options.values ?? {})) if (!consumed.has(name)) throw new ApigoError('UNKNOWN_PARAMETER', `Unknown operation parameter: --${name}.`, 2, 'Use -q name=value to add a query parameter outside the specification.');
  for (const name of Object.keys(options.params ?? {})) if (!operation.parameters.some(parameter => parameter.in === 'path' && parameter.name === name)) throw new ApigoError('UNKNOWN_PARAMETER', `Unknown path parameter: ${name}.`);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (!operation.parameters.some(parameter => parameter.in === 'query' && parameter.name === name)) query.push(...(Array.isArray(value) ? value : [value]).map(item => [name, String(item)] as [string, string]));
  }

  const content = operation.requestBody?.content ?? {};
  const contentTypes = Object.keys(content);
  const contentType = options.contentType ?? headers['content-type'] ?? contentTypes.find(type => type === 'application/json') ?? contentTypes.find(type => type.endsWith('+json')) ?? contentTypes[0];
  const media = contentType ? content[contentType.split(';')[0]!] ?? content[contentType] : undefined;
  if (contentType && contentTypes.length && !media && options.body !== undefined) throw new ApigoError('UNSUPPORTED_MEDIA_TYPE', 'The selected content type is not defined by this operation.');
  let body = options.body;
  if (typeof body === 'string' && contentType?.includes('json')) body = parseJson(body, 'request body JSON');
  const example = mediaExample(media);
  if (body === undefined && options.example && operation.requestBody) body = interpolate(example === undefined ? generateBody(media?.schema ?? {}, api.document) : requestExample(example, media?.schema ?? {}, api.document), variables);
  if (body === undefined && operation.requestBody?.required) {
    if (!prompts) throw new ApigoError('MISSING_BODY', 'This operation requires a request body.', 2, 'Pass -b @body.json, or inspect a generated body with --example --dry-run.');
    body = await prompts.body(media?.schema ?? {}, api.document, example);
    optionsToSave.body = typeof body === 'string' && contentType?.includes('json') ? JSON.stringify(body) : body;
    prompted = true;
  }
  if (body !== undefined && media?.schema !== undefined) validateValue(body, media.schema, api.document, 'request body');
  if (containsRedaction({ body, headers, query, path })) throw new ApigoError('REDACTED_INPUT', 'This request contains redacted values from history.', 2, 'Supply fresh values or use environment placeholders before replaying.');
  const baseTemplate = options.baseUrl ?? variables.BASE_URL ?? operation.servers[0] ?? api.baseUrl;
  const baseUrl = baseTemplate === undefined ? undefined : interpolate(baseTemplate, variables);
  const url = operation.url && !options.baseUrl && !variables.BASE_URL ? interpolate(operation.url, variables) : `${baseUrl?.replace(/\/$/, '') ?? ''}${path}`;
  const wireBody = typeof body === 'string' && contentType?.includes('json') ? JSON.stringify(body) : body;
  const request = prepareHttp(operation.method, url, { ...options, body: wireBody, headers, query: {}, contentType });
  const parsedUrl = new URL(request.url);
  for (const [name, value] of query) parsedUrl.searchParams.append(name, value);
  request.url = parsedUrl.toString();
  return { request, options: optionsToSave, prompted };
}
