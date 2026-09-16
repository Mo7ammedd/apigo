import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareHttp } from '../src/core/request.js';
import { sendRequest } from '../src/http/client.js';
import { formatResponse } from '../src/output/response.js';
import { Redactor } from '../src/utils/security.js';

const server = createServer(async (req, res) => {
  if (req.url === '/slow') { setTimeout(() => res.end('late'), 200); return; }
  if (req.url === '/large') { res.end('x'.repeat(4096)); return; }
  if (req.url === '/redirect') { res.writeHead(302, { location: '/echo' }); res.end(); return; }
  if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
  if (req.url === '/error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"Unauthorized"}'); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sessionid=private-value' });
  res.end(JSON.stringify({ method: req.method, url: req.url, header: req.headers['x-custom'], body: Buffer.concat(chunks).toString() }));
});
let base: string;
beforeAll(async () => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

describe('HTTP foundation', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const)('executes %s with headers and encoded query', async method => {
    const request = prepareHttp(method, `${base}/echo`, { headers: { 'X-Custom': 'yes' }, query: { search: 'a&b', tag: ['one', 'two'] }, ...(method === 'GET' ? {} : { body: { name: 'test' } }) });
    const response = await sendRequest(request);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ method, url: '/echo?search=a%26b&tag=one&tag=two', header: 'yes', body: method === 'GET' ? '' : '{"name":"test"}' });
    expect(response.timings.totalMs).toBeGreaterThan(0);
    expect(response.timings.tcpMs).toBeGreaterThanOrEqual(0);
  });
  it('enforces a whole-request timeout', async () => { await expect(sendRequest(prepareHttp('GET', `${base}/slow`, { timeout: 20 }))).rejects.toMatchObject({ code: 'TIMEOUT', exitCode: 4 }); });
  it('caps downloaded responses', async () => { await expect(sendRequest(prepareHttp('GET', `${base}/large`, { maxResponseBytes: 100 }))).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' }); });
  it('follows redirects only on opt-in', async () => {
    expect((await sendRequest(prepareHttp('GET', `${base}/redirect`, {}))).status).toBe(302);
    expect((await sendRequest(prepareHttp('GET', `${base}/redirect`, { followRedirects: true }))).redirects).toBe(1);
  });
  it('formats JSON/status/headers without decoration and masks sensitive headers', async () => {
    const request = prepareHttp('GET', `${base}/echo`, {});
    const response = await sendRequest(request);
    const redactor = new Redactor();
    expect(JSON.parse(formatResponse(request, response, { json: true }, redactor)).method).toBe('GET');
    expect(formatResponse(request, response, { status: true }, redactor)).toBe('200\n');
    expect(formatResponse(request, response, { headers: true }, redactor)).not.toContain('private-value');
  });
  it('handles empty and error responses as HTTP responses', async () => {
    expect((await sendRequest(prepareHttp('GET', `${base}/empty`, {}))).body).toBe('');
    expect((await sendRequest(prepareHttp('GET', `${base}/error`, {}))).status).toBe(401);
  });
  it('rejects unsafe URL and header input', () => {
    expect(() => prepareHttp('GET', 'file:///etc/passwd', {})).toThrow('HTTP');
    expect(() => prepareHttp('GET', base, { headers: { 'X-Foo': 'x\r\nInjected: yes' } })).toThrow('header');
    expect(() => prepareHttp('GET', base, { body: {} })).toThrow('cannot have a body');
  });
});
