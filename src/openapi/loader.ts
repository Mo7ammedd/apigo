import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $RefParser } from '@apidevtools/json-schema-ref-parser';
import type { FileInfo } from '@apidevtools/json-schema-ref-parser';
import { parse as parseYaml } from 'yaml';
import { ApigoError } from '../core/errors.js';
import type { Document } from '../core/types.js';
import { prepareHttp } from '../core/request.js';
import { httpUrl, sendRequest } from '../http/client.js';
import { isRecord } from '../utils/objects.js';

export interface LoadOptions {
  verify?: boolean;
  timeout?: number;
  headers?: Record<string, string>;
  allowExternal?: boolean;
}

const MAX_SPEC_BYTES = 10 * 1024 * 1024;

export function parseDocument(text: string): Document {
  if (Buffer.byteLength(text) > MAX_SPEC_BYTES) throw new ApigoError('SPEC_TOO_LARGE', 'Specification exceeds 10 MB.');
  let value: unknown;
  try {
    value = /^[\s\uFEFF]*[{[]/.test(text) ? JSON.parse(text.replace(/^\uFEFF/, '')) : parseYaml(text, { maxAliasCount: 100, uniqueKeys: true });
  } catch { throw new ApigoError('INVALID_SPEC', 'The specification is not valid JSON or YAML.'); }
  if (!isRecord(value)) throw new ApigoError('INVALID_SPEC', 'Expected an OpenAPI document object.');
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > 250_000 || item.depth > 100) throw new ApigoError('SPEC_TOO_COMPLEX', 'Specification exceeds the structural complexity limit.');
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  // Clone shared YAML aliases into ordinary JSON; cyclic aliases exceeded the depth limit above.
  return JSON.parse(JSON.stringify(value)) as Document;
}

async function readLocal(path: string): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new ApigoError('FILE_READ', 'The specification source must be a file.');
    if (info.size > MAX_SPEC_BYTES) throw new ApigoError('SPEC_TOO_LARGE', 'Specification exceeds 10 MB.');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof ApigoError) throw error;
    throw new ApigoError('FILE_READ', 'Could not read the specification file.');
  }
}

export async function loadDocument(source: string, options: LoadOptions = {}): Promise<{ document: Document; source: string }> {
  const remote = /^https?:\/\//i.test(source);
  if (!remote && /^[a-z][a-z+.-]*:\/\//i.test(source)) throw new ApigoError('INVALID_URL', 'Specifications must use a local file or an HTTP(S) URL.');
  let origin: string | undefined;
  let location: string;
  let text: string;
  if (remote) {
    const url = httpUrl(source);
    origin = url.origin;
    const response = await sendRequest(prepareHttp('GET', url.toString(), { ...options, followRedirects: true, maxResponseBytes: MAX_SPEC_BYTES }));
    if (response.status < 200 || response.status >= 300) throw new ApigoError('SPEC_HTTP_ERROR', `Specification server returned HTTP ${response.status}.`, 3);
    text = response.body;
    location = response.url;
    origin = new URL(location).origin;
  } else {
    try { location = await realpath(resolve(source)); }
    catch { throw new ApigoError('FILE_READ', 'Could not find the specification file.'); }
    text = await readLocal(location);
  }
  const document = parseDocument(text);
  let count = 0;
  let bytes = Buffer.byteLength(text);
  const rootDirectory = remote ? undefined : dirname(location);
  try {
    const bundled = await new $RefParser<Document>().bundle(location, document, {
      mutateInputSchema: false,
      timeoutMs: options.timeout ?? 30_000,
      parse: {
        json: false, yaml: false, binary: false, text: false,
        apigo: { order: 1, canParse: () => true, parse: (file: FileInfo) => parseDocument(String(file.data)) },
      },
      resolve: {
        file: false, http: false,
        apigo: {
          order: 1,
          canRead: () => true,
          read: async (file: FileInfo) => {
            if (++count > 50) throw new ApigoError('REF_LIMIT', 'A specification may reference at most 50 external files.');
            let content: string;
            if (/^https?:\/\//i.test(file.url)) {
              const url = httpUrl(file.url);
              if (url.origin !== origin && !options.allowExternal) throw new ApigoError('EXTERNAL_REF', 'External references must share the specification origin.', 2, 'Use --allow-external to allow references from other origins.');
              const response = await sendRequest(prepareHttp('GET', url.toString(), {
                ...options,
                headers: url.origin === origin ? options.headers : {},
                followRedirects: false, maxResponseBytes: MAX_SPEC_BYTES,
              }));
              if (response.status !== 200) throw new ApigoError('REF_HTTP_ERROR', `Reference server returned HTTP ${response.status}.`, 3);
              content = response.body;
            } else {
              if (remote) throw new ApigoError('UNSAFE_REF', 'Remote specifications cannot read local files.');
              const path = await realpath(file.url.startsWith('file:') ? fileURLToPath(file.url) : decodeURIComponent(file.url));
              const relativePath = relative(rootDirectory!, path);
              if ((relativePath.startsWith('..') || isAbsolute(relativePath)) && !options.allowExternal) {
                throw new ApigoError('EXTERNAL_REF', 'Local references must stay inside the specification directory.', 2, 'Use --allow-external to allow references outside that directory.');
              }
              content = await readLocal(path);
            }
            bytes += Buffer.byteLength(content);
            if (bytes > 50 * 1024 * 1024) throw new ApigoError('SPEC_TOO_LARGE', 'The specification and its references exceed 50 MB.');
            return content;
          },
        },
      },
    });
    return { document: bundled, source: location };
  } catch (error) {
    if (error instanceof ApigoError) throw error;
    throw new ApigoError('INVALID_REF', 'Could not resolve a specification reference.', 2, 'Check $ref paths. Remote references must share the origin; local references must stay in the specification directory unless --allow-external is set.');
  }
}
