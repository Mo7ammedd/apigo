import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cli } from './support.js';

let source = '';
let base = '';
let directory = '';
const seen: { method: string; url: string; authorization?: string; body: string }[] = [];
const server = createServer(async (req, res) => {
  if (req.url === '/swagger/v1/swagger.json') { res.setHeader('content-type', 'application/json'); res.end(source); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
  res.setHeader('content-type', 'application/json');
  res.setHeader('set-cookie', 'sessionid=server-session-secret');
  if (req.url === '/health') { res.end('{"healthy":true}'); return; }
  if (req.url === '/api/vehicles/999') { res.writeHead(404); res.end('{"error":"Not found"}'); return; }
  if (req.url?.startsWith('/api/auth/login')) { res.end('{"token":"response-token-secret","refresh_token":"response-refresh-secret","echo":"server-session-secret"}'); return; }
  if (req.method === 'POST') { res.writeHead(201); res.end(Buffer.concat(chunks)); return; }
  res.end('[{"id":42,"vin":"1HGCM82633A004352","make":"Honda"}]');
});
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const document = JSON.parse(await readFile('tests/fixtures/aspnet-openapi.json', 'utf8'));
  document.servers = [{ url: base }]; source = JSON.stringify(document);
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'apigo-cli-')); seen.length = 0; });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function imported() {
  const result = await cli(directory, ['openapi', `${base}/swagger/v1/swagger.json`, '--name', 'carlink', '--json']);
  expect(result.code, result.stderr).toBe(0); expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toMatchObject({ name: 'carlink', endpoints: 7 });
}

describe('CLI across processes', () => {
  it('provides help/version without initializing local storage', async () => {
    const help = await cli(directory, ['--help']); const version = await cli(directory, ['--version']);
    expect(help.code).toBe(0); expect(help.stdout).toContain('openapi'); expect(version.stdout.trim()).toBe('0.1.0');
    await expect(readFile(join(directory, 'apigo.db'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('imports Swagger, accepts dynamic operation flags, and produces pipeable JSON/status/headers', async () => {
    await imported();
    const auth = await cli(directory, ['auth', 'set', 'bearer', '--token-env', 'APIGO_CLI_TOKEN']); expect(auth.code, auth.stderr).toBe(0);
    const result = await cli(directory, ['run', 'vehicles.get', '--id', '42', '--json'], { APIGO_CLI_TOKEN: 'cli-bearer-secret' });
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)[0].id).toBe(42); expect(result.stderr).toBe('');
    expect(seen.at(-1)).toMatchObject({ url: '/api/vehicles/42', authorization: 'Bearer cli-bearer-secret' });
    const status = await cli(directory, ['run', 'health.check', '--status']); expect(status.stdout).toBe('200\n'); expect(status.stderr).toBe('');
    const headers = await cli(directory, ['run', 'health.check', '--headers', '--json']);
    expect(JSON.parse(headers.stdout)['set-cookie']).toBe('[REDACTED]');
    const repeated = await cli(directory, ['run', 'vehicles.list', '-q', 'tags=one', '-q', 'tags=two', '--no-auth', '--status']);
    expect(repeated.code, repeated.stderr).toBe(0);
    expect(new URL(seen.at(-1)!.url, base).searchParams.getAll('tags')).toEqual(['one', 'two']);
  });
  it('reports missing input without prompting or sending a request in CI', async () => {
    await imported();
    const missing = await cli(directory, ['run', 'vehicles.get', '--json', '--no-auth']);
    expect(missing.code).toBe(2); expect(missing.stdout).toBe(''); expect(missing.stderr).toContain('--id'); expect(seen).toHaveLength(0);
    const body = await cli(directory, ['run', 'vehicles.create', '--no-auth']);
    expect(body.code).toBe(2); expect(body.stderr).toContain('requires a request body'); expect(seen).toHaveLength(0);
  });
  it('stores overrides and replays saved requests and history with fresh authentication', async () => {
    await imported();
    await cli(directory, ['auth', 'set', 'bearer', '--token-env', 'APIGO_CLI_TOKEN']);
    const first = await cli(directory, ['run', 'vehicles.list', '--page', '2', '--limit', '50', '-H', 'X-Debug: yes', '--json'], { APIGO_CLI_TOKEN: 'first-bearer-secret' });
    expect(first.code, first.stderr).toBe(0);
    const saved = await cli(directory, ['save', 'vehicles-page-two']); expect(saved.code, saved.stderr).toBe(0);
    const replay = await cli(directory, ['run', 'vehicles-page-two', '--json'], { APIGO_CLI_TOKEN: 'second-bearer-secret' });
    expect(replay.code, replay.stderr).toBe(0); expect(seen.at(-1)).toMatchObject({ url: '/api/vehicles?page=2&limit=50', authorization: 'Bearer second-bearer-secret' });
    const listing = await cli(directory, ['history', '--json']); const id = JSON.parse(listing.stdout)[0].id as string;
    const history = await cli(directory, ['history', 'show', id, '--json']); expect(history.stdout).not.toContain('bearer-secret');
    const historyReplay = await cli(directory, ['history', 'run', id, '--page', '3', '--json'], { APIGO_CLI_TOKEN: 'third-bearer-secret' });
    expect(historyReplay.code, historyReplay.stderr).toBe(0); expect(seen.at(-1)?.url).toBe('/api/vehicles?page=3&limit=50');
  });
  it('masks response credentials and verbose request details unless explicitly requested', async () => {
    await imported();
    const args = ['run', 'auth.login', '-b', '{"email":"developer@example.com","password":"request-password-secret"}', '--json'];
    const result = await cli(directory, [...args, '--verbose']);
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout).token).toBe('[REDACTED]');
    expect(result.stderr).toContain('TIMING'); expect(result.stderr).not.toContain('request-password-secret');
    const explicit = await cli(directory, [...args, '--show-sensitive']); expect(JSON.parse(explicit.stdout).token).toBe('response-token-secret');
    const listing = await cli(directory, ['history', '--json']); const id = JSON.parse(listing.stdout)[0].id as string;
    const history = await cli(directory, ['history', 'show', id, '--json', '--show-sensitive']);
    expect(result.stdout).not.toContain('server-session-secret');
    expect(history.stdout).not.toMatch(/request-password-secret|response-token-secret|response-refresh-secret|server-session-secret/);
  });
  it('keeps HTTP error status machine-readable and exits nonzero', async () => {
    await imported();
    const result = await cli(directory, ['run', 'vehicles.get', '--id', '999', '--no-auth', '--status']);
    expect(result.code).toBe(1); expect(result.stdout).toBe('404\n'); expect(result.stderr).toBe('');
  });
  it('masks every environment value by default and applies BASE_URL during request generation', async () => {
    await imported();
    expect((await cli(directory, ['env', 'create', 'local', '--set', `BASE_URL=${base}`, '--set', 'TOKEN=environment-secret'])).code).toBe(0);
    const show = await cli(directory, ['env', 'show', 'local', '--json']);
    expect(JSON.parse(show.stdout).values).toEqual({ BASE_URL: '[REDACTED]', TOKEN: '[REDACTED]' });
    await cli(directory, ['auth', 'set', 'bearer']);
    const request = await cli(directory, ['run', 'vehicles.list', '--json']); expect(request.code, request.stderr).toBe(0);
    expect(seen.at(-1)?.authorization).toBe('Bearer environment-secret');
    const explicit = await cli(directory, ['env', 'show', 'local', '--json', '--show-sensitive']); expect(JSON.parse(explicit.stdout).values.TOKEN).toBe('environment-secret');
  });
  it('supports schema inspection, body files/stdin, and dry runs without recording network activity', async () => {
    await imported();
    const schema = await cli(directory, ['schema', 'show', 'CreateVehicleRequest', '--example', '--json']);
    const body = JSON.parse(schema.stdout);
    const request = await cli(directory, ['run', 'vehicles.create', '--no-auth', '-b', '@-', '--json'], {}, JSON.stringify(body));
    expect(request.code, request.stderr).toBe(0); expect(JSON.parse(request.stdout).vin).toBe('1HGCM82633A004352');
    const before = seen.length;
    const preview = await cli(directory, ['run', 'vehicles.create', '--example', '--dry-run', '--json']);
    expect(preview.code, preview.stderr).toBe(0); expect(JSON.parse(preview.stdout).body.vin).toBe('1HGCM82633A004352'); expect(seen).toHaveLength(before);
  });
  it('masks credentials in command parser errors before opening storage', async () => {
    const result = await cli(directory, ['config', 'list', '--token=invalid-option-secret']);
    expect(result.code).toBe(2); expect(result.stderr).not.toContain('invalid-option-secret');
    expect(result.stderr).toContain('unknown option');
  });
});
