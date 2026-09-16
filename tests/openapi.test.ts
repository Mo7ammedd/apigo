import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadDocument, parseDocument } from '../src/openapi/loader.js';
import { parseOpenApi } from '../src/openapi/parser.js';
import { generateBody, mediaExample } from '../src/openapi/generator.js';
import { findOperation } from '../src/core/operation.js';
import { prepareOperation } from '../src/core/operation-request.js';
import { resolveSchema } from '../src/openapi/resolver.js';
import { interpolate } from '../src/environments/interpolation.js';
import { validateValue } from '../src/openapi/validation.js';
import type { Document } from '../src/core/types.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
async function api(name = 'aspnet-openapi.json') { const loaded = await loadDocument(fixture(name)); return parseOpenApi(loaded.document, loaded.source); }

describe('OpenAPI import and operation discovery', () => {
  it('loads realistic ASP.NET Core JSON with metadata, responses, refs, and intuitive names', async () => {
    const definition = await api();
    expect(definition.specVersion).toBe('3.0.1');
    expect(definition.operations).toHaveLength(7);
    expect(Object.keys(definition.schemas)).toHaveLength(5);
    expect(findOperation(definition, 'vehicles.list').operationId).toBe('GetVehicles');
    expect(findOperation(definition, 'GetVehicleById').key).toBe('vehicles.get');
    expect(findOperation(definition, 'vehicles.get').parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(findOperation(definition, 'health.check').security).toEqual([]);
    expect(findOperation(definition, 'vehicles.list').responses['200']).toHaveProperty('content.application/json.example');
  });
  it('uses operationId as the name when unambiguous', () => {
    const definition = parseOpenApi({ openapi: '3.0.0', info: { title: 'API', version: '1' }, paths: { '/vehicles': { get: { tags: ['Vehicles'], operationId: 'getVehicles', responses: {} } } } }, 'http://localhost/swagger.json');
    expect(definition.operations[0]?.key).toBe('vehicles.get');
    expect(findOperation(definition, 'vehicles.list')).toBe(definition.operations[0]);
  });
  it('loads YAML OpenAPI 3.1 with nullable union types and server variables', async () => {
    const definition = await api('openapi31.yaml');
    expect(definition.baseUrl).toBe('https://eu.example.com/v2');
    const operation = findOperation(definition, 'tasks.create');
    expect(mediaExample(operation.requestBody?.content['application/json'])).toEqual({ title: 'Build apigo', completed: false, due: null });
    expect(() => validateValue({ title: 'Test', completed: true, due: null }, definition.schemas.Task!, definition.document, 'task')).not.toThrow();
  });
  it('normalizes Swagger 2.0 parameters, body schemas, and security schemes', async () => {
    const definition = await api('swagger2.json');
    expect(definition.baseUrl).toBe('http://localhost:5000/v1');
    expect(definition.securitySchemes.Basic).toMatchObject({ type: 'http', scheme: 'basic' });
    expect(findOperation(definition, 'items.create').requestBody?.required).toBe(true);
    const result = await prepareOperation(definition, findOperation(definition, 'items.list'), { values: { ids: '1,2,3' } });
    expect(new URL(result.request.url).searchParams.get('ids')).toBe('1,2,3');
  });
  it('loads /swagger/v1/swagger.json from a URL and infers a missing server', async () => {
    const document = JSON.parse(await readFile(fixture('aspnet-openapi.json'), 'utf8')) as Document;
    delete document.servers;
    const server = createServer((req, res) => { expect(req.url).toBe('/swagger/v1/swagger.json'); res.end(JSON.stringify(document)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const loaded = await loadDocument(`${base}/swagger/v1/swagger.json`);
      expect(parseOpenApi(loaded.document, loaded.source).baseUrl).toBe(base);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('bundles local external refs and keeps recursive schemas serializable', async () => {
    const definition = await api('references/openapi.yaml');
    const operation = definition.operations[0]!;
    const schema = operation.requestBody!.content['application/json']!.schema!;
    expect(resolveSchema(schema, definition.document).properties).toHaveProperty('name');
    expect(() => JSON.stringify(definition)).not.toThrow();
    expect(generateBody(schema, definition.document)).toHaveProperty('name', '');
  });
  it('rejects malformed documents, missing pointers, and unsupported versions', async () => {
    expect(() => parseDocument('{"openapi":')).toThrow('JSON or YAML');
    expect(() => parseOpenApi({ openapi: '4.0.0' }, 'test.json')).toThrow('OpenAPI 3.0');
    expect(() => resolveSchema({ $ref: '#/absent' }, {})).toThrow('missing');
    await expect(loadDocument(fixture('absent.json'))).rejects.toMatchObject({ code: 'FILE_READ' });
  });
  it.each([
    { paths: { '/broken': [] } },
    { paths: { '/broken': { get: { responses: {}, parameters: {} } } } },
    { paths: { '/broken': { get: { responses: [] } } } },
    { components: { securitySchemes: { Auth: { type: 'apiKey', in: 'header' } } } },
    { servers: {} },
  ])('rejects malformed OpenAPI structures during import', invalid => {
    expect(() => parseOpenApi({ openapi: '3.0.3', info: { title: 'Malformed', version: '1' }, paths: {}, ...invalid }, 'test.json')).toThrow();
  });
  it('accepts shared YAML aliases while rejecting cyclic documents', () => {
    expect(parseDocument('a: &schema\n  type: string\nb: *schema')).toEqual({ a: { type: 'string' }, b: { type: 'string' } });
    expect(() => parseDocument('a: &cycle\n  next: *cycle')).toThrow();
  });
  it('prevents remote references from reading local files even with --allow-external', async () => {
    const server = createServer((_request, response) => response.end(JSON.stringify({
      openapi: '3.0.3', info: { title: 'Unsafe', version: '1' }, paths: {},
      components: { schemas: { Secret: { $ref: new URL('./fixtures/swagger2.json', import.meta.url).href } } },
    })));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await expect(loadDocument(`http://127.0.0.1:${(server.address() as AddressInfo).port}/swagger.json`, { allowExternal: true })).rejects.toThrow('reference');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

describe('request generation', () => {
  it('coerces path/query values, applies defaults, encodes paths, and validates constraints', async () => {
    const definition = await api();
    const get = await prepareOperation(definition, findOperation(definition, 'vehicles.get'), { values: { id: '42' } }, { BASE_URL: 'http://localhost:9000' });
    expect(get.request.url).toBe('http://localhost:9000/api/vehicles/42');
    const list = await prepareOperation(definition, findOperation(definition, 'vehicles.list'), { values: { page: '2', tags: 'a&b,c' } });
    expect(new URL(list.request.url).searchParams.getAll('tags')).toEqual(['a&b', 'c']);
    expect(new URL(list.request.url).searchParams.get('limit')).toBe('20');
    await expect(prepareOperation(definition, findOperation(definition, 'vehicles.list'), { values: { limit: '101' } })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('requires missing parameters and body without silently sending placeholders', async () => {
    const definition = await api();
    await expect(prepareOperation(definition, findOperation(definition, 'vehicles.get'), {})).rejects.toMatchObject({ code: 'MISSING_PARAMETERS' });
    await expect(prepareOperation(definition, findOperation(definition, 'vehicles.create'), {})).rejects.toMatchObject({ code: 'MISSING_BODY' });
    await expect(prepareOperation(definition, findOperation(definition, 'vehicles.list'), { values: { limti: 1 } })).rejects.toMatchObject({ code: 'UNKNOWN_PARAMETER' });
  });
  it('generates nested request bodies, honors examples/enums, and omits read-only fields', async () => {
    const definition = await api();
    const result = generateBody(definition.schemas.CreateVehicleRequest!, definition.document) as Record<string, unknown>;
    expect(result).toMatchObject({ vin: '1HGCM82633A004352', make: 'Honda', year: 2023, status: 'active' });
    expect(result.owner).not.toHaveProperty('id');
    expect(() => validateValue(result, definition.schemas.CreateVehicleRequest!, definition.document, 'body')).not.toThrow();
    const request = await prepareOperation(definition, findOperation(definition, 'vehicles.create'), { example: true });
    expect(JSON.parse(request.request.body!).vin).toBe('1HGCM82633A004352');
  });
  it('prefers request examples and supports generated scalar/array values', async () => {
    const definition = await api('openapi31.yaml');
    const result = await prepareOperation(definition, definition.operations[0]!, { example: true });
    expect(JSON.parse(result.request.body!)).toEqual({ title: 'Build apigo', completed: false, due: null });
    expect(generateBody({ type: 'array', items: { type: 'boolean' } }, {})).toEqual([false]);
    expect(generateBody({ type: ['null', 'string'], default: null }, {})).toBe(null);
  });
  it('serializes JSON string bodies once, strips read-only example fields, and handles repeated numeric queries', async () => {
    const definition = parseOpenApi({ openapi: '3.1.0', info: { title: 'Scalar API', version: '1' }, servers: [{ url: 'https://example.com' }], paths: {
      '/values': { post: { parameters: [{ name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'integer' } } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'string' }, example: 'hello' } } }, responses: {} } },
    } }, 'scalar.json');
    const operation = definition.operations[0]!;
    const generated = await prepareOperation(definition, operation, { example: true, query: { ids: ['1', '2'] } });
    expect(generated.request.body).toBe('"hello"');
    expect(new URL(generated.request.url).searchParams.getAll('ids')).toEqual(['1', '2']);
    expect((await prepareOperation(definition, operation, { body: '"custom"' })).request.body).toBe('"custom"');
    operation.requestBody!.content['application/json'] = { schema: { type: 'object', properties: { id: { type: 'integer', readOnly: true }, name: { type: 'string' } } }, example: { id: 1, name: 'example' } };
    expect(JSON.parse((await prepareOperation(definition, operation, { example: true })).request.body!)).toEqual({ name: 'example' });
    expect(generateBody({ type: 'integer', maximum: -4 }, {})).toBeLessThanOrEqual(-4);
  });
  it('obtains required input through the prompt adapter and preserves values for replay', async () => {
    const definition = await api();
    const prompts = { parameter: async () => 42, body: async () => ({ vin: '1HGCM82633A004352', make: 'Honda', model: 'Accord', year: 2023 }), confirmRequest: async () => true };
    const get = await prepareOperation(definition, findOperation(definition, 'vehicles.get'), {}, {}, prompts);
    expect(get.prompted).toBe(true); expect(get.options.values?.id).toBe(42); expect(get.request.url).toContain('/42');
    const create = await prepareOperation(definition, findOperation(definition, 'vehicles.create'), {}, {}, prompts);
    expect(create.prompted).toBe(true); expect(create.options.body).toHaveProperty('year', 2023);
  });
  it('resolves environment variables recursively and detects missing/cyclic values', () => {
    expect(interpolate({ url: '{{BASE_URL}}/vehicles', body: { token: '{{TOKEN}}' } }, { BASE_URL: '{{ORIGIN}}/v1', ORIGIN: 'https://api.example.com', TOKEN: 'private' })).toEqual({ url: 'https://api.example.com/v1/vehicles', body: { token: 'private' } });
    expect(() => interpolate('{{MISSING}}', {})).toThrow('not set');
    expect(() => interpolate('{{A}}', { A: '{{B}}', B: '{{A}}' })).toThrow('circular');
  });
});
