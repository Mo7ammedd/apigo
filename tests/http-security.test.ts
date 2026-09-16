import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareHttp } from '../src/core/request.js';
import { sendRequest } from '../src/http/client.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe('HTTP security boundaries', () => {
  it('drops credentials and custom headers across origins and refuses body forwarding', async () => {
    const received: { url: string; headers: Record<string, unknown> }[] = [];
    const destination = createHttpServer((request, response) => {
      received.push({ url: request.url!, headers: request.headers }); response.end('ok');
    });
    const destinationUrl = await listen(destination);
    const source = createHttpServer((request, response) => {
      response.writeHead(request.url === '/body' ? 307 : 302, { location: `${destinationUrl}/receive?api_key=redirect-secret&custom=other-secret&page=1` });
      response.end();
    });
    const sourceUrl = await listen(source);
    try {
      const request = prepareHttp('GET', `${sourceUrl}/redirect`, {
        followRedirects: true, headers: { Authorization: 'Bearer header-secret', Cookie: 'session=cookie-secret', 'X-Private': 'private-value' },
      });
      request.sensitiveQuery.push('custom');
      expect((await sendRequest(request)).status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.url).toBe('/receive?page=1');
      expect(received[0]?.headers).not.toHaveProperty('authorization');
      expect(received[0]?.headers).not.toHaveProperty('cookie');
      expect(received[0]?.headers).not.toHaveProperty('x-private');
      await expect(sendRequest(prepareHttp('POST', `${sourceUrl}/body`, { followRedirects: true, body: { password: 'body-secret' } }))).rejects.toMatchObject({ code: 'UNSAFE_REDIRECT' });
      expect(received).toHaveLength(1);
    } finally { await close(source); await close(destination); }
  });

  // Generate ephemeral certificates: private keys never belong in repository fixtures.
  it.skipIf(spawnSync('openssl', ['version'], { stdio: 'ignore' }).status !== 0)('scopes --no-verify to one request and rejects HTTPS downgrades', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'apigo-tls-'));
    let server: Server | undefined;
    const tlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost']);
      server = createHttpsServer({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) }, (request, response) => {
        if (request.url === '/downgrade') response.writeHead(302, { location: 'http://127.0.0.1:1/unsafe' });
        response.end('secure');
      });
      const url = (await listen(server)).replace('http:', 'https:');
      await expect(sendRequest(prepareHttp('GET', url, {}))).rejects.toMatchObject({ exitCode: 3 });
      expect((await sendRequest(prepareHttp('GET', url, { verify: false }))).body).toBe('secure');
      await expect(sendRequest(prepareHttp('GET', url, {}))).rejects.toMatchObject({ exitCode: 3 });
      await expect(sendRequest(prepareHttp('GET', `${url}/downgrade`, { verify: false, followRedirects: true }))).rejects.toMatchObject({ code: 'INSECURE_REDIRECT' });
      expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(tlsSetting);
    } finally { if (server) await close(server); await rm(directory, { recursive: true, force: true }); }
  });

  it('reports refused connections without including request credentials', async () => {
    const unused = createHttpServer(); const url = await listen(unused); await close(unused);
    await expect(sendRequest(prepareHttp('GET', url, { headers: { Authorization: 'Bearer never-log-this' } }))).rejects.toMatchObject({ code: 'ECONNREFUSED', message: 'Request failed.', exitCode: 3 });
  });
});
