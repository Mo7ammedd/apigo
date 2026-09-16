import chalk from 'chalk';
import type { HttpResponse, PreparedRequest } from '../core/types.js';
import { terminalSafe } from '../utils/security.js';
import type { Redactor } from '../utils/security.js';

export interface OutputOptions {
  json?: boolean;
  raw?: boolean;
  bodyOnly?: boolean;
  status?: boolean;
  headers?: boolean;
  verbose?: boolean;
  showSensitive?: boolean;
}

export function machineOutput(options: OutputOptions): boolean {
  return Boolean(options.json || options.raw || options.bodyOnly || options.status || options.headers);
}

export function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(2)} KB`;
}

export function responseValue(response: HttpResponse, redactor: Redactor, showSensitive = false): unknown {
  let body: unknown;
  try { body = JSON.parse(response.body); } catch { body = response.body; }
  return showSensitive ? body : redactor.clean(body);
}

export function formatResponse(request: PreparedRequest, response: HttpResponse, options: OutputOptions, redactor: Redactor): string {
  const value = responseValue(response, redactor, options.showSensitive);
  if (options.status) return `${response.status}\n`;
  if (options.headers) {
    const headers = options.showSensitive ? response.headers : redactor.headers(response.headers);
    return options.json ? `${JSON.stringify(headers, null, 2)}\n` : `${Object.entries(headers).map(([key, val]) => `${key}: ${terminalSafe(val)}`).join('\n')}\n`;
  }
  if (options.json) return `${JSON.stringify(value, null, 2)}\n`;
  if (options.raw) {
    const raw = options.showSensitive ? response.body : redactor.body(response.body);
    return terminalSafe(raw);
  }
  const pretty = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (options.bodyOnly) return pretty ? `${terminalSafe(pretty)}\n` : '';
  const status = `${response.status} ${response.statusText}`.trim();
  const color = response.status >= 500 ? chalk.red : response.status >= 400 ? chalk.yellow : response.status >= 200 && response.status < 300 ? chalk.green : chalk.white;
  const url = options.showSensitive ? request.url : redactor.url(request.url);
  return `${request.method} ${terminalSafe(url)}\n\n${color(status)}  ·  ${response.timings.totalMs}ms  ·  ${size(response.bytes)}\n\n${terminalSafe(pretty || '(empty response)')}\n`;
}

export function formatVerbose(request: PreparedRequest, response: HttpResponse | undefined, redactor: Redactor, showSensitive = false): string {
  const headers = showSensitive ? request.headers : redactor.headers(request.headers);
  const url = showSensitive ? request.url : redactor.url(request.url);
  const lines = ['REQUEST', `${request.method} ${terminalSafe(url)}`, '', 'HEADERS',
    ...Object.entries(headers).map(([key, value]) => `${key}: ${terminalSafe(value)}`),
  ];
  if (request.body !== undefined) lines.push('', 'BODY', terminalSafe(showSensitive ? request.body : redactor.body(request.body)));
  if (response) {
    const t = response.timings;
    lines.push('', 'TIMING');
    if (t.dnsMs !== undefined) lines.push(`DNS       ${t.dnsMs}ms`);
    if (t.tcpMs !== undefined) lines.push(`TCP       ${t.tcpMs}ms`);
    if (t.tlsMs !== undefined) lines.push(`TLS       ${t.tlsMs}ms`);
    lines.push(`HEADERS   ${t.headersMs}ms`, `DOWNLOAD  ${t.downloadMs}ms`, `TOTAL     ${t.totalMs}ms`,
      '', 'RESPONSE', `${response.status} ${response.statusText}  ·  ${size(response.bytes)}`);
    if (response.redirects) lines.push(`Redirects: ${response.redirects}`);
  }
  return `${lines.join('\n')}\n`;
}
