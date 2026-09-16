import { performance } from 'node:perf_hooks';
import type { Socket } from 'node:net';
import { Agent, buildConnector, fetch } from 'undici';
import { ApigoError, errorCode } from '../core/errors.js';
import type { HttpResponse, PreparedRequest } from '../core/types.js';
import { RequestClock } from './timing.js';
import { isSensitiveKey } from '../utils/security.js';

export function httpUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ApigoError('INVALID_URL', 'Expected an absolute HTTP or HTTPS URL.', 2, 'Set BASE_URL in an environment or pass --base-url.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ApigoError('INVALID_URL', 'Only HTTP and HTTPS URLs are supported.');
  if (url.username || url.password) throw new ApigoError('INVALID_URL', 'Credentials in URLs are not supported.', 2, 'Use apigo auth set basic instead.');
  url.hash = '';
  return url;
}

export async function sendRequest(request: PreparedRequest): Promise<HttpResponse> {
  const clock = new RequestClock();
  const controller = new AbortController();
  let timedOut = false;
  let interrupted = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeout);
  timer.unref();
  const interrupt = (): void => { interrupted = true; controller.abort(); };
  process.once('SIGINT', interrupt);
  const connect = buildConnector({ rejectUnauthorized: request.verify });
  const agent = new Agent({ connect(options, callback) {
    const start = performance.now();
    let lookupAt = start;
    let connectedAt = start;
    // Undici returns the socket at runtime; its connector interface deliberately permits void.
    const socket = connect(options, callback) as unknown as Socket;
    socket.once('lookup', () => { lookupAt = performance.now(); clock.add('dnsMs', lookupAt - start); });
    socket.once('connect', () => { connectedAt = performance.now(); clock.add('tcpMs', connectedAt - lookupAt); });
    socket.once('secureConnect', () => clock.add('tlsMs', performance.now() - connectedAt));
    return socket;
  } });

  try {
    let url = httpUrl(request.url);
    let method = request.method;
    let body = request.body;
    let headers = { ...request.headers };
    let redirects = 0;
    for (;;) {
      const response = await fetch(url, {
        method, headers, body, dispatcher: agent, redirect: 'manual', signal: controller.signal,
      });
      const location = response.headers.get('location');
      if (request.followRedirects && location && [301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (++redirects > 5) throw new ApigoError('TOO_MANY_REDIRECTS', 'Stopped after five redirects.', 3);
        const next = httpUrl(new URL(location, url).toString());
        if (url.protocol === 'https:' && next.protocol !== 'https:') {
          throw new ApigoError('INSECURE_REDIRECT', 'Refusing a redirect from HTTPS to HTTP.', 3);
        }
        if (response.status === 303 && method !== 'HEAD' || [301, 302].includes(response.status) && method === 'POST') {
          method = 'GET'; body = undefined;
          delete headers['content-type']; delete headers['content-length'];
        }
        if (next.origin !== url.origin) {
          if (body !== undefined) throw new ApigoError('UNSAFE_REDIRECT', 'Refusing to forward a request body to a different origin.', 3);
          headers = Object.fromEntries(Object.entries(headers).filter(([key]) => ['accept', 'user-agent'].includes(key.toLowerCase())));
          for (const key of [...next.searchParams.keys()]) {
            if (isSensitiveKey(key) || request.sensitiveQuery.includes(key)) next.searchParams.delete(key);
          }
        }
        url = next;
        continue;
      }

      clock.headers();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > request.maxResponseBytes) {
              await reader.cancel();
              throw new ApigoError('RESPONSE_TOO_LARGE', `Response exceeds the ${request.maxResponseBytes} byte limit.`, 3, 'Adjust maxResponseBytes with apigo config set.');
            }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      return {
        url: url.toString(), status: response.status, statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: Buffer.concat(chunks).toString('utf8'), bytes, timings: clock.finish(), redirects,
      };
    }
  } catch (error) {
    if (error instanceof ApigoError) throw error;
    if (interrupted) throw new ApigoError('INTERRUPTED', 'Request cancelled.', 130);
    if (timedOut) throw new ApigoError('TIMEOUT', `Request timed out after ${request.timeout}ms.`, 4);
    const code = errorCode(error);
    const safeCode = code && /^[A-Z0-9_]+$/.test(code) ? code : 'NETWORK_ERROR';
    const tls = /CERT|TLS|SSL|SELF_SIGNED/.test(safeCode);
    throw new ApigoError(safeCode, 'Request failed.', 3, tls ? 'Trust your development certificate, or explicitly use --no-verify for this request.' : undefined);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    await agent.destroy();
  }
}
