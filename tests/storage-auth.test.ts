import { readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testContext } from './support.js';
import { Store } from '../src/storage/database.js';
import { storagePaths } from '../src/config/paths.js';
import { Redactor, REDACTED, terminalSafe } from '../src/utils/security.js';
import { prepareHttp } from '../src/core/request.js';
import type { Credential } from '../src/auth/service.js';
import type { ApiRecord, Operation, SecurityScheme } from '../src/core/types.js';

afterEach(() => vi.unstubAllEnvs());

describe('local persistence', () => {
  it('persists API definitions, encrypted environments, collections, and configuration across reopen', async () => {
    const fixture = await testContext(); const { app, directory } = fixture;
    try {
      const api = await app.apis.import('tests/fixtures/aspnet-openapi.json', 'carlink');
      app.environments.create('local', { BASE_URL: 'https://localhost:7043', TOKEN: 'secret-at-rest-12345' });
      app.config.set('timeout', 1234);
      const second = new Store(storagePaths(directory));
      try {
        expect(second.getApi('carlink')?.definition.operations).toHaveLength(7);
        expect(second.environment('local')?.TOKEN).toBe('secret-at-rest-12345');
        expect(second.collections(api.id).find(group => group.name === 'vehicles')?.operations).toHaveLength(5);
        expect(second.config().timeout).toBe(1234);
        expect((await readFile(join(directory, 'apigo.db'))).includes('secret-at-rest-12345')).toBe(false);
        expect((await readFile(join(directory, 'apigo.db-wal'))).includes('secret-at-rest-12345')).toBe(false);
        if (process.platform !== 'win32') {
          expect((await stat(directory)).mode & 0o777).toBe(0o700);
          expect((await stat(join(directory, 'secret.key'))).mode & 0o777).toBe(0o600);
        }
      } finally { second.close(); }
    } finally { await fixture.cleanup(); }
  });
  it('detects tampered encrypted data and missing keys without destroying the database', async () => {
    const fixture = await testContext();
    try {
      const encoded = fixture.app.store.vault.seal({ token: 'sensitive' }, 'test');
      expect(() => fixture.app.store.vault.open(encoded, 'other')).toThrow('decrypt');
      expect(() => fixture.app.store.vault.open(`${encoded.slice(0, -4)}AAAA`, 'test')).toThrow('decrypt');
      await rm(join(fixture.directory, 'secret.key'));
      expect(() => new Store(storagePaths(fixture.directory))).toThrow('key');
    } finally { await fixture.cleanup(); }
  });
  it('records redacted history and saved overrides, trims retention, and supports prefix IDs', async () => {
    const fixture = await testContext(); const { app } = fixture;
    try {
      const request = prepareHttp('POST', 'https://api.example.com/login?token=secret-query', { headers: { Authorization: 'Bearer secret-header' }, body: { password: 'secret-password', other: 'echo secret-header' } });
      app.runner.register(request);
      const recipe = { kind: 'http' as const, method: 'POST' as const, url: request.url, options: { headers: request.headers, body: { password: 'secret-password' } } };
      const first = app.history.record(recipe, request, 1);
      const second = app.history.record(recipe, request, 1);
      expect(app.history.list()).toHaveLength(1);
      expect(() => app.history.get(first.id)).toThrow('not found');
      const history = app.history.get(second.id.slice(0, 6));
      expect(JSON.stringify(history)).not.toMatch(/secret-query|secret-header|secret-password/);
      expect(history.request.headers.authorization).toBe(REDACTED);
      expect(history.recipe.options.headers).not.toHaveProperty('authorization');
      const saved = app.history.save('login', { ...recipe, options: { body: { password: '{{PASSWORD}}' } } });
      expect(saved.recipe.options.body).toEqual({ password: '{{PASSWORD}}' });
      expect(app.store.saved('login')).toEqual(saved);
      expect(() => app.history.save('login', recipe)).toThrow('already exists');
    } finally { await fixture.cleanup(); }
  });
  it('keeps environments independent of API removal', async () => {
    const fixture = await testContext();
    try {
      const api = await fixture.app.apis.import('tests/fixtures/aspnet-openapi.json');
      fixture.app.environments.create('local', { BASE_URL: 'https://localhost:7043' });
      fixture.app.apis.remove(api.name);
      expect(fixture.app.environments.get('local').values.BASE_URL).toBe('https://localhost:7043');
      expect(fixture.app.store.collections(api.id)).toEqual([]);
    } finally { await fixture.cleanup(); }
  });
});

describe('OpenAPI authentication', () => {
  async function setup() { const fixture = await testContext(); const api = await fixture.app.apis.import('tests/fixtures/aspnet-openapi.json'); return { ...fixture, api }; }
  it('requires credentials, attaches bearer tokens, honors public operations and --no-auth', async () => {
    const fixture = await setup(); const { app, api } = fixture;
    try {
      await expect(app.runner.prepare(app.runner.recipe('vehicles.list'))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      app.auth.set(api.id, 'default', { type: 'bearer', token: { value: 'private-bearer-token' } });
      expect((await app.runner.prepare(app.runner.recipe('vehicles.list'))).request.headers.authorization).toBe('Bearer private-bearer-token');
      expect((await app.runner.prepare(app.runner.recipe('health.check'))).request.headers.authorization).toBeUndefined();
      expect((await app.runner.prepare(app.runner.recipe('vehicles.list', { noAuth: true }))).request.headers.authorization).toBeUndefined();
      expect(app.redactor.clean({ token: 'private-bearer-token' }).token).toBe(REDACTED);
    } finally { await fixture.cleanup(); }
  });
  it('resolves fresh process and selected environment credentials', async () => {
    const fixture = await setup(); const { app, api } = fixture;
    try {
      app.auth.set(api.id, 'default', { type: 'oauth2', token: { env: 'APIGO_TEST_ACCESS_TOKEN' } });
      vi.stubEnv('APIGO_TEST_ACCESS_TOKEN', 'first-token');
      expect((await app.runner.prepare(app.runner.recipe('vehicles.list'))).request.headers.authorization).toBe('Bearer first-token');
      vi.stubEnv('APIGO_TEST_ACCESS_TOKEN', 'second-token');
      expect((await app.runner.prepare(app.runner.recipe('vehicles.list'))).request.headers.authorization).toBe('Bearer second-token');
      app.environments.create('local', { TOKEN: 'environment-token', BASE_URL: 'https://local.example.com' });
      app.auth.set(api.id, 'default', { type: 'bearer', token: { value: '{{TOKEN}}' } });
      const plan = await app.runner.prepare(app.runner.recipe('vehicles.list'));
      expect(plan.request.headers.authorization).toBe('Bearer environment-token');
      expect(plan.request.url).toContain('https://local.example.com');
    } finally { await fixture.cleanup(); }
  });
  it.each([
    [{ type: 'http', scheme: 'basic' }, { type: 'basic', username: { value: 'alice' }, password: { value: 'private-password' } }, 'authorization', `Basic ${Buffer.from('alice:private-password').toString('base64')}`],
    [{ type: 'apiKey', name: 'X-Custom-Credential', in: 'header' }, { type: 'apikey', token: { value: 'private-api-key' } }, 'x-custom-credential', 'private-api-key'],
  ] as [SecurityScheme, Credential, string, string][])('attaches named HTTP authentication schemes', async (scheme, credential, header, expected) => {
    const fixture = await setup();
    try {
      const api: ApiRecord = { ...fixture.api, definition: { ...fixture.api.definition, securitySchemes: { Auth: scheme } } };
      const operation: Operation = { ...api.definition.operations[0]!, security: [{ Auth: [] }] };
      fixture.app.auth.set(api.id, 'Auth', credential);
      const request = prepareHttp('GET', 'https://api.example.com', {});
      fixture.app.auth.apply(request, api, operation, {});
      expect(request.headers[header]).toBe(expected);
      fixture.app.runner.register(request);
      expect(fixture.app.redactor.headers(request.headers)[header]).toBe(REDACTED);
    } finally { await fixture.cleanup(); }
  });
  it('satisfies AND/OR requirements and supports query and cookie API keys', async () => {
    const fixture = await setup(); const { app } = fixture;
    try {
      const api: ApiRecord = { ...fixture.api, definition: { ...fixture.api.definition, securitySchemes: {
        Bearer: { type: 'http', scheme: 'bearer' }, Query: { type: 'apiKey', in: 'query', name: 'custom' }, Cookie: { type: 'apiKey', in: 'cookie', name: 'sid' },
      } } };
      const operation = { ...api.definition.operations[0]!, security: [{ Bearer: [], Query: [], Cookie: [] }] };
      app.auth.set(api.id, 'Bearer', { type: 'bearer', token: { value: 'bearer-test-value' } });
      app.auth.set(api.id, 'Query', { type: 'apikey', token: { value: 'query-test-value' } });
      app.auth.set(api.id, 'Cookie', { type: 'apikey', token: { value: 'cookie-test-value' } });
      const request = prepareHttp('GET', 'https://api.example.com', {});
      app.auth.apply(request, api, operation, {});
      expect(new URL(request.url).searchParams.get('custom')).toBe('query-test-value');
      expect(request.headers.cookie).toBe('sid=cookie-test-value');
      expect(request.headers.authorization).toBe('Bearer bearer-test-value');
      expect(app.redactor.url(request.url)).not.toContain('query-test-value');
      app.auth.remove(api.id);
      expect(() => app.auth.apply(prepareHttp('GET', request.url, {}), api, { ...operation, security: [{ Bearer: [] }, {}] }, {})).not.toThrow();
    } finally { await fixture.cleanup(); }
  });
  it('does not attach global credentials to direct requests without explicit opt-in', async () => {
    const fixture = await testContext();
    try {
      fixture.app.auth.set('*', 'default', { type: 'bearer', token: { value: 'global-token' } });
      const recipe = { kind: 'http' as const, method: 'GET' as const, url: 'https://example.com', options: {} };
      expect((await fixture.app.runner.prepare(recipe)).request.headers.authorization).toBeUndefined();
      expect((await fixture.app.runner.prepare({ ...recipe, options: { useAuth: true } })).request.headers.authorization).toBe('Bearer global-token');
    } finally { await fixture.cleanup(); }
  });
});

describe('sensitive output filtering', () => {
  it('masks nested credentials, URLs, and echoed values, while preserving raw nonsecret text', () => {
    const redactor = new Redactor(); redactor.add('known-secret');
    expect(redactor.clean({ user: { password: 'unknown-secret', access_token: 'anything' }, message: 'echo known-secret' })).toEqual({ user: { password: REDACTED, access_token: REDACTED }, message: `echo ${REDACTED}` });
    expect(redactor.url('https://user:password@api.example.com?api_key=value')).not.toMatch(/password|=value/);
    expect(redactor.body('{\n  "id": 42\n}\n')).toBe('{\n  "id": 42\n}\n');
    expect(terminalSafe('\u001b[31mred\u001b[0m\u001b]52;c;payload\u0007')).toBe('red');
  });
  it('preserves complete variable references without retaining mixed literal credentials', () => {
    const redactor = new Redactor();
    const input = { password: '{{PASSWORD}}', authorization: 'Bearer {{TOKEN}}', client_secret: '{{PREFIX}}literal-secret' };
    redactor.collect(input);
    expect(redactor.clean(input, true)).toEqual({ password: '{{PASSWORD}}', authorization: 'Bearer {{TOKEN}}', client_secret: REDACTED });
    const url = redactor.url('https://example.com?api_key={{API_KEY}}&page=2', true);
    expect(url).toContain('api_key={{API_KEY}}');
    expect(redactor.url(url, true)).toBe(url);
    redactor.collect({ 'set-cookie': 'session=first-cookie; Path=/, other=second-cookie; HttpOnly' });
    expect(redactor.clean({ echo: 'first-cookie second-cookie' }).echo).toBe(`${REDACTED} ${REDACTED}`);
  });
  it('keeps sensitive schema property definitions visible while masking example credentials', () => {
    const redactor = new Redactor();
    expect(redactor.metadata({ schemas: { Login: { properties: { password: { type: 'string', format: 'password', example: 'example-secret' } } } } })).toEqual({ schemas: { Login: { properties: { password: { type: 'string', format: 'password', example: REDACTED } } } } });
  });
});
