import { ApigoError } from './errors.js';
import type { HttpMethod, PreparedRequest, RequestOptions } from './types.js';
import { httpUrl } from '../http/client.js';
import { isRecord, parseJson } from '../utils/objects.js';

export const DEFAULT_REQUEST = { timeout: 30_000, verify: true, followRedirects: false, maxResponseBytes: 10 * 1024 * 1024 };

export function normalizeHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || [...value].some(character => {
      const code = character.codePointAt(0)!;
      return code < 32 && character !== '\t' || code === 127 || code > 255;
    })) {
      throw new ApigoError('INVALID_HEADER', 'Invalid request header name or value.');
    }
    if (['host', 'content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) {
      throw new ApigoError('INVALID_HEADER', `Header ${name} is managed by the HTTP client.`);
    }
    result[name.toLowerCase()] = value;
  }
  return result;
}

export function encodeBody(value: unknown, contentType: string | undefined): { body?: string; contentType?: string } {
  if (value === undefined) return {};
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  if (typeof value === 'string' && type?.includes('json')) parseJson(value, 'request body JSON');
  if (type === 'application/x-www-form-urlencoded' && isRecord(value)) {
    const form = new URLSearchParams();
    for (const [key, item] of Object.entries(value)) {
      for (const entry of Array.isArray(item) ? item : [item]) form.append(key, typeof entry === 'object' ? JSON.stringify(entry) : String(entry));
    }
    return { body: form.toString(), contentType };
  }
  if (type?.startsWith('multipart/')) throw new ApigoError('UNSUPPORTED_MEDIA_TYPE', 'Multipart uploads are not supported in this MVP.', 2, 'Use a JSON or URL-encoded request body when the endpoint supports it.');
  if (typeof value === 'string') return { body: value, contentType: contentType ?? 'text/plain' };
  return { body: JSON.stringify(value), contentType: contentType ?? 'application/json' };
}

export function prepareHttp(method: HttpMethod, urlValue: string, options: RequestOptions): PreparedRequest {
  if (method === 'TRACE') throw new ApigoError('UNSUPPORTED_METHOD', 'TRACE requests are not supported by Fetch.');
  const url = httpUrl(urlValue);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.delete(key);
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'apigo/0.1.0', ...normalizeHeaders(options.headers) };
  const encoded = encodeBody(options.body, options.contentType ?? headers['content-type']);
  if (encoded.body !== undefined && ['GET', 'HEAD'].includes(method)) throw new ApigoError('VALIDATION', `${method} requests cannot have a body.`);
  if (encoded.contentType) headers['content-type'] = encoded.contentType;
  return {
    method, url: url.toString(), headers, body: encoded.body,
    timeout: options.timeout ?? DEFAULT_REQUEST.timeout,
    verify: options.verify ?? DEFAULT_REQUEST.verify,
    followRedirects: options.followRedirects ?? DEFAULT_REQUEST.followRedirects,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_REQUEST.maxResponseBytes,
    sensitiveHeaders: [], sensitiveQuery: [], sensitiveCookies: [],
  };
}

export function mergeOptions(base: RequestOptions, overrides: RequestOptions): RequestOptions {
  return {
    ...base, ...overrides,
    headers: { ...base.headers, ...overrides.headers },
    query: { ...base.query, ...overrides.query },
    params: { ...base.params, ...overrides.params },
    values: { ...base.values, ...overrides.values },
  };
}
