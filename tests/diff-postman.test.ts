import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testContext } from './support.js';
import { loadDocument } from '../src/openapi/loader.js';
import { parseOpenApi } from '../src/openapi/parser.js';
import { diffApis, hasChanges } from '../src/openapi/diff.js';
import { loadPostman, parsePostman } from '../src/postman/importer.js';
import { exportPostman, writePostman } from '../src/postman/exporter.js';
import { PostmanService } from '../src/postman/service.js';
import { findOperation } from '../src/core/operation.js';
import type { Document, SchemaObject } from '../src/core/types.js';

async function source() { return (await loadDocument('tests/fixtures/aspnet-openapi.json')).document; }

describe('OpenAPI diff and refresh', () => {
  it('identifies added/removed endpoints, changed parameters, schema fields, and breaking changes', async () => {
    const before = await source(); const after = structuredClone(before);
    const paths = after.paths as Record<string, Document>;
    delete paths['/api/vehicles/{id}']!.delete;
    paths['/api/recommendations'] = { get: { tags: ['Recommendations'], responses: { '200': { description: 'OK' } } } };
    ((paths['/api/vehicles']!.get as Document).parameters as Document[]).push({ name: 'sort', in: 'query', required: true, schema: { type: 'string' } });
    const schemas = (after.components as Document).schemas as Record<string, SchemaObject>;
    delete schemas.Vehicle!.properties!.make;
    schemas.Vehicle!.properties!.color = { type: 'string' };
    const diff = diffApis(parseOpenApi(before, 'http://localhost/swagger.json'), parseOpenApi(after, 'http://localhost/swagger.json'));
    expect(diff.addedOperations).toContain('GET /api/recommendations');
    expect(diff.removedOperations).toContain('DELETE /api/vehicles/{id}');
    expect(diff.changedOperations.find(item => item.name === 'GET /api/vehicles')?.changes).toContainEqual({ message: '+ sort query parameter (required)', breaking: true });
    expect(diff.changedSchemas.find(item => item.name === 'Vehicle')?.changes).toContainEqual({ message: '- make', breaking: true });
    expect(diff.breaking).toBe(true);
  });
  it('does not mark optional parameter additions or description edits as breaking', async () => {
    const before = await source(); const after = structuredClone(before);
    const paths = after.paths as Record<string, Document>;
    ((paths['/api/vehicles']!.get as Document).parameters as Document[]).push({ name: 'sort', in: 'query', schema: { type: 'string' } });
    (paths['/health']!.get as Document).description = 'Expanded health check docs';
    const diff = diffApis(parseOpenApi(before, 'http://localhost/swagger.json'), parseOpenApi(after, 'http://localhost/swagger.json'));
    expect(hasChanges(diff)).toBe(true); expect(diff.breaking).toBe(false);
    expect(hasChanges(diffApis(parseOpenApi(before, 'x.json'), parseOpenApi(before, 'x.json')))).toBe(false);
  });
  it('keeps environments and saved overrides during refresh and remembers the last diff', async () => {
    const fixture = await testContext();
    try {
      const path = join(fixture.directory, 'source.json');
      const before = await source(); await writeFile(path, JSON.stringify(before));
      const api = await fixture.app.apis.import(path, 'carlink');
      fixture.app.environments.create('local', { BASE_URL: 'https://custom.example.com' });
      fixture.app.history.save('custom-list', fixture.app.runner.recipe('vehicles.list', { values: { limit: 7 }, noAuth: true }));
      const after = structuredClone(before); (after.info as Document).version = 'v2';
      (after.paths as Document)['/api/new'] = { get: { tags: ['New'], responses: {} } }; await writeFile(path, JSON.stringify(after));
      const compared = await fixture.app.apis.diff('carlink', true); expect(compared.addedOperations).toEqual(['GET /api/new']);
      expect(fixture.app.apis.select('carlink').definition.version).toBe('v1');
      const refreshed = await fixture.app.apis.refresh('carlink'); expect(refreshed.api.id).toBe(api.id);
      expect(refreshed.api.definition.version).toBe('v2'); expect(await fixture.app.apis.diff('carlink')).toEqual(refreshed.diff);
      expect(fixture.app.environments.get('local').values.BASE_URL).toBe('https://custom.example.com');
      const plan = await fixture.app.runner.prepare(fixture.app.runner.recipe('custom-list')); expect(new URL(plan.request.url).searchParams.get('limit')).toBe('7');
      expect(fixture.app.collections.list(refreshed.api).some(item => item.name === 'new')).toBe(true);
      await writeFile(path, 'not valid: [');
      await expect(fixture.app.apis.refresh('carlink')).rejects.toMatchObject({ code: 'INVALID_SPEC' });
      expect(fixture.app.apis.select('carlink').definition.version).toBe('v2');
    } finally { await fixture.cleanup(); }
  });
});

describe('Postman interoperability', () => {
  it('imports folders, bodies, query/path variables, and auth without executing scripts', async () => {
    const loaded = await loadPostman('tests/fixtures/postman.json');
    expect(loaded.definition.operations).toHaveLength(3); expect(loaded.warnings).toHaveLength(1);
    expect(findOperation(loaded.definition, 'vehicles.get').parameters[0]).toMatchObject({ name: 'id', in: 'path' });
    expect(findOperation(loaded.definition, 'vehicles.list').preset?.query).toEqual({ page: '1' });
    expect(loaded.variables.TOKEN).toBe('postman-test-secret');
    expect(JSON.stringify(loaded.definition)).not.toContain('postman-test-secret');
  });
  it('creates an encrypted environment and prepares imported operations with overrides', async () => {
    const fixture = await testContext();
    try {
      const service = new PostmanService(fixture.app.apis, fixture.app.environments);
      const result = await service.import('tests/fixtures/postman.json', 'imported');
      expect(result.environment).toBe('imported-postman');
      const plan = await fixture.app.runner.prepare(fixture.app.runner.recipe('vehicles.get'));
      expect(plan.request.url).toBe('https://localhost:7043/api/vehicles/42'); expect(plan.request.headers.authorization).toBe('Bearer postman-test-secret');
      const create = await fixture.app.runner.prepare(fixture.app.runner.recipe('vehicles.create'));
      expect(JSON.parse(create.request.body!).year).toBe(2023);
      const overridden = await fixture.app.runner.prepare(fixture.app.runner.recipe('vehicles.list', { values: { page: '9' } }));
      expect(new URL(overridden.request.url).searchParams.get('page')).toBe('9');
      fixture.app.history.save('custom-page', overridden.recipe);
      const replay = await fixture.app.runner.prepare(fixture.app.runner.recipe('custom-page', { values: { page: '10' } }));
      expect(new URL(replay.request.url).searchParams.get('page')).toBe('10');
      fixture.app.environments.set(result.environment!, 'BASE_URL', 'https://override.example.com');
      await service.import('tests/fixtures/postman.json', 'imported');
      expect(fixture.app.environments.get(result.environment!).values.BASE_URL).toBe('https://override.example.com');
    } finally { await fixture.cleanup(); }
  });
  it('extracts inline credentials into variables and rejects malformed collections', () => {
    const result = parsePostman({ info: { name: 'Test' }, item: [{ name: 'Secret', request: { method: 'GET', url: 'https://example.com/private', header: [{ key: 'Authorization', value: 'Bearer inline-secret-token' }] } }] }, 'collection.json');
    expect(JSON.stringify(result.definition)).not.toContain('inline-secret-token');
    expect(Object.values(result.variables)).toContain('Bearer inline-secret-token');
    expect(() => parsePostman({}, 'bad.json')).toThrow('Postman collection');
  });
  it('exports usable Postman v2.1 collections with placeholders and prevents accidental overwrite', async () => {
    const fixture = await testContext();
    try {
      const api = await fixture.app.apis.import('tests/fixtures/aspnet-openapi.json');
      fixture.app.auth.set(api.id, 'default', { type: 'bearer', token: { value: 'must-never-export' } });
      const exported = exportPostman(api.definition);
      expect(JSON.stringify(exported)).not.toContain('must-never-export');
      const roundtrip = parsePostman(exported, 'export.json'); expect(roundtrip.definition.operations).toHaveLength(7);
      const path = join(fixture.directory, 'collection.json'); await writePostman(api.definition, path);
      expect(JSON.parse(await readFile(path, 'utf8')).info.schema).toContain('v2.1.0');
      await expect(writePostman(api.definition, path)).rejects.toMatchObject({ code: 'FILE_EXISTS' });
    } finally { await fixture.cleanup(); }
  });
  it('exports scalar JSON examples correctly and removes URL credentials and literal API keys', () => {
    const api = parseOpenApi({ openapi: '3.1.0', info: { title: 'Scalar', version: '1' }, servers: [{ url: 'https://user:private-password@example.com?api_key=private-key' }], paths: {
      '/text': { post: { requestBody: { content: { 'application/json': { schema: { type: 'string' }, example: 'hello' } } }, responses: {} } },
    } }, 'example.json');
    const exported = exportPostman(api);
    expect(JSON.stringify(exported)).not.toMatch(/private-password|private-key/);
    const roundtrip = parsePostman(exported, 'export.json');
    expect(roundtrip.definition.operations[0]?.preset?.body).toBe('"hello"');
    api.operations[0]!.servers = ['{{BASE_URL}}/v2?api_key=other-private-key'];
    expect(JSON.stringify(exportPostman(api))).not.toContain('other-private-key');
  });
});

describe('collection planning', () => {
  it('preflights all requests and detects mutation consent before execution', async () => {
    const fixture = await testContext();
    try {
      const api = await fixture.app.apis.import('tests/fixtures/aspnet-openapi.json');
      const plans = await fixture.app.collections.prepare(api, 'vehicles', fixture.app.runner, { params: { id: '42' }, example: true, noAuth: true }, { dryRun: true });
      expect(plans).toHaveLength(5); expect(fixture.app.collections.needsConfirmation(plans)).toBe(true);
      expect(plans.find(plan => plan.request.method === 'POST')?.request.body).toContain('1HGCM82633A004352');
      await expect(fixture.app.collections.prepare(api, 'vehicles', fixture.app.runner, { noAuth: true }, {})).rejects.toMatchObject({ code: 'MISSING_BODY' });
      expect(fixture.app.history.list()).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
});
