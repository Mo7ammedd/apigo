import { readFile, stat } from 'node:fs/promises';
import { Option } from 'commander';
import type { Command } from 'commander';
import { ApigoError } from '../core/errors.js';
import type { RequestOptions } from '../core/types.js';
import type { OutputOptions } from '../output/response.js';
import { parseJson, record } from '../utils/objects.js';

function collect(value: string, previous: string[]): string[] { return [...previous, value]; }

export function requestOptions(command: Command): Command {
  return command
    .option('-H, --header <name:value>', 'set a request header (repeatable)', collect, [])
    .option('-q, --query <name=value>', 'set a query parameter (repeatable)', collect, [])
    .option('-p, --param <name=value>', 'set a path parameter (repeatable)', collect, [])
    .option('-b, --body [value]', 'request body: inline, @file, @-; omit value for response body only')
    .option('--content-type <type>', 'override request content type')
    .option('--base-url <url>', 'override the API server')
    .option('--timeout <ms>', 'whole-request timeout in milliseconds')
    .option('--verify', 'verify TLS certificates (overrides configuration)')
    .option('--no-verify', 'skip TLS certificate verification for this request')
    .option('--follow-redirects', 'follow up to five redirects')
    .option('--auth', 'use global authentication for a direct HTTP request')
    .option('--no-auth', 'omit configured authentication')
    .option('--no-history', 'do not store this request in history')
    .option('--example', 'use an OpenAPI example or generated body')
    .option('--dry-run', 'print the prepared request without sending it')
    .option('-y, --yes', 'confirm generated bodies and collection execution')
    .addOption(new Option('--raw', 'output response text without decoration').conflicts(['status', 'headers']))
    .addOption(new Option('--status', 'output only the numeric HTTP status').conflicts(['raw', 'headers']))
    .addOption(new Option('--headers', 'output only response headers').conflicts(['raw', 'status']))
    .option('--verbose', 'print request details and measured timings to stderr');
}

export function pairs(values: string[], separator: ':' | '='): Record<string, string> {
  const entries = values.map(value => {
    const index = value.indexOf(separator);
    if (index <= 0) throw new ApigoError('VALIDATION', `Expected ${separator === ':' ? 'Header: value' : 'name=value'}.`);
    return [value.slice(0, index).trim(), value.slice(index + 1).trim()] as const;
  });
  return Object.fromEntries(entries);
}

function queryPairs(values: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const value of values) {
    const [key, item] = Object.entries(pairs([value], '='))[0]!;
    if (!Object.hasOwn(result, key)) result[key] = item;
    else result[key] = [...(Array.isArray(result[key]) ? result[key] as unknown[] : [result[key]]), item];
  }
  return result;
}

export function dynamicOptions(args: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!/^--[A-Za-z_][A-Za-z0-9_.-]*(?:=.*)?$/.test(arg)) {
      throw new ApigoError('VALIDATION', 'Operation parameters must use --name value or --name=value.');
    }
    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals < 0 ? undefined : equals);
    const next = args[index + 1];
    const value = equals >= 0 ? arg.slice(equals + 1) : next !== undefined && !next.startsWith('--') ? args[++index] : true;
    if (Object.hasOwn(result, name)) throw new ApigoError('VALIDATION', `Parameter --${name} was provided more than once.`, 2, 'Use a comma-separated list or a JSON array for array parameters.');
    result[name] = value;
  }
  return result;
}

export async function bodyInput(value: string): Promise<unknown> {
  let text = value;
  if (value === '@-') {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > 10 * 1024 * 1024) throw new ApigoError('BODY_TOO_LARGE', 'Request input exceeds 10 MB.');
      chunks.push(buffer);
    }
    text = Buffer.concat(chunks).toString('utf8');
  } else if (value.startsWith('@')) {
    try {
      const info = await stat(value.slice(1));
      if (!info.isFile()) throw new ApigoError('FILE_READ', 'The request body source must be a regular file.');
      if (info.size > 10 * 1024 * 1024) throw new ApigoError('BODY_TOO_LARGE', 'Request input exceeds 10 MB.');
      text = await readFile(value.slice(1), 'utf8');
    } catch (error) { if (error instanceof ApigoError) throw error; throw new ApigoError('FILE_READ', 'Could not read the request body file.'); }
  }
  if (/^\s*[{[]/.test(text)) return parseJson(text, 'request body JSON');
  return text;
}

export async function toRequestOptions(raw: Record<string, unknown>, args: string[] = []): Promise<RequestOptions> {
  const timeout = raw.timeout === undefined ? undefined : Number(raw.timeout);
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000)) {
    throw new ApigoError('VALIDATION', 'Timeout must be an integer between 1 and 600000 milliseconds.');
  }
  return {
    headers: pairs((raw.header ?? []) as string[], ':'),
    query: queryPairs((raw.query ?? []) as string[]),
    params: pairs((raw.param ?? []) as string[], '='),
    values: dynamicOptions(args),
    ...(typeof raw.body === 'string' ? { body: await bodyInput(raw.body) } : {}),
    ...(typeof raw.contentType === 'string' ? { contentType: raw.contentType } : {}),
    ...(typeof raw.baseUrl === 'string' ? { baseUrl: raw.baseUrl } : {}),
    ...(timeout === undefined ? {} : { timeout }),
    ...(typeof raw.verify === 'boolean' ? { verify: raw.verify } : {}),
    ...(raw.followRedirects === undefined ? {} : { followRedirects: Boolean(raw.followRedirects) }),
    ...(raw.auth === false ? { noAuth: true } : {}),
    ...(raw.auth === true ? { useAuth: true } : {}),
    ...(raw.history === false ? { noHistory: true } : {}),
    ...(raw.example ? { example: true } : {}),
  };
}

export function toOutputOptions(raw: Record<string, unknown>): OutputOptions {
  if (raw.json && raw.raw) throw new ApigoError('VALIDATION', 'Choose either --json or --raw.');
  return {
    json: Boolean(raw.json), raw: Boolean(raw.raw), bodyOnly: raw.body === true,
    status: Boolean(raw.status), headers: Boolean(raw.headers),
    verbose: Boolean(raw.verbose), showSensitive: Boolean(raw.showSensitive),
  };
}

export function options(command: Command): Record<string, unknown> { return record(command.optsWithGlobals()); }
