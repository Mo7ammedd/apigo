import { stripVTControlCharacters } from 'node:util';
import { isRecord } from './objects.js';

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'key' ||
    /authorization|password|passwd|secret|token|cookie|credential|apikey|privatekey|accesskey|sessionid|signature/.test(normalized);
}

export function terminalSafe(value: string): string {
  // eslint-disable-next-line no-control-regex -- Strip terminal control bytes from untrusted server output.
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

function onlyTemplate(value: unknown): boolean {
  return typeof value === 'string' && /^(?:(?:Bearer|Basic)\s+)?\{\{\s*[A-Za-z_][A-Za-z0-9_.-]*\s*\}\}$/.test(value);
}

/** One redactor is shared by output, diagnostics, and persistence for a command. */
export class Redactor {
  private readonly secrets = new Set<string>();
  private readonly sensitiveNames = new Set<string>();

  add(value: unknown): void {
    if (typeof value !== 'string' || !value || value === REDACTED || onlyTemplate(value)) return;
    this.secrets.add(value);
    this.secrets.add(encodeURIComponent(value));
    if (value.startsWith('Bearer ')) this.secrets.add(value.slice(7));
    if (value.startsWith('Basic ')) this.secrets.add(value.slice(6));
  }

  addName(name: string): void { this.sensitiveNames.add(name.toLowerCase()); }
  sensitive(name: string): boolean { return isSensitiveKey(name) || this.sensitiveNames.has(name.toLowerCase()); }

  collect(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(item => this.collect(item)); return; }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (this.sensitive(key)) {
        this.add(item);
        if (typeof item === 'string' && /^(cookie|set-cookie)$/i.test(key)) {
          const pieces = key.toLowerCase() === 'cookie' ? item.split(';') : item.split(/,(?=\s*[^;,=]+=[^;,]*)/).map(cookie => cookie.split(';')[0]!);
          for (const piece of pieces) { const index = piece.indexOf('='); if (index >= 0) this.add(piece.slice(index + 1).trim()); }
        }
      }
      else this.collect(item);
    }
  }

  text(value: string, preserveTemplates = false): string {
    let result = value;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      if (secret.length >= 4) result = result.split(secret).join(REDACTED);
      else if (result === secret) result = REDACTED;
    }
    // Also cover credentials in text responses and parser diagnostics, without echoing their values.
    return result
      .replace(/\b(Bearer|Basic)\s+(?!(?:authentication|auth|tokens?|configuration|credentials|or|and)\b)[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
      .replace(/((?:["']?(?:password|passwd|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|authorization|cookie|set-cookie)["']?)\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s&,;\n]+)/gi, (_match, prefix: string, raw: string) => {
        let candidate = raw.replace(/^["']|["']$/g, '');
        try { candidate = decodeURIComponent(candidate); } catch { /* Malformed URL escapes remain literal text. */ }
        return preserveTemplates && onlyTemplate(candidate) ? `${prefix}${raw}` : `${prefix}"${REDACTED}"`;
      });
  }

  clean<T>(value: T, preserveTemplates = false): T {
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') {
        if (preserveTemplates && onlyTemplate(item)) return item;
        if (/^https?:\/\//i.test(item)) return this.url(item, preserveTemplates);
        if (preserveTemplates && /^\s*[{[]/.test(item)) { try { return JSON.stringify(this.clean(JSON.parse(item), true)); } catch { /* Not a JSON value. */ } }
        return this.text(item, preserveTemplates);
      }
      if (Array.isArray(item)) return item.map(walk);
      if (!isRecord(item)) return item;
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key,
        this.sensitive(key) && child !== undefined && !(preserveTemplates && onlyTemplate(child))
          ? REDACTED : walk(child),
      ]));
    };
    return walk(value) as T;
  }

  url(value: string, preserveTemplates = false): string {
    try {
      const url = new URL(value);
      if (url.username) url.username = REDACTED;
      if (url.password) url.password = REDACTED;
      for (const key of [...url.searchParams.keys()]) {
        if ((this.sensitive(key) || key === 'code') && !(preserveTemplates && onlyTemplate(url.searchParams.get(key)))) url.searchParams.set(key, REDACTED);
      }
      const result = this.text(url.toString(), preserveTemplates);
      return preserveTemplates ? result.replace(/%7B%7B(?:%20)*[A-Za-z_][A-Za-z0-9_.-]*(?:%20)*%7D%7D/gi, match => decodeURIComponent(match)) : result;
    } catch { return this.text(value, preserveTemplates); }
  }

  body(value: string, preserveTemplates = false): string {
    try {
      const parsed: unknown = JSON.parse(value);
      const clean = this.clean(parsed, preserveTemplates);
      return JSON.stringify(parsed) === JSON.stringify(clean) ? value : JSON.stringify(clean);
    }
    catch { return this.text(value); }
  }

  headers(headers: Record<string, string>): Record<string, string> {
    return this.clean(headers);
  }

  /** Redact example values without treating schema/property/security-scheme names as credentials. */
  metadata<T>(value: T): T {
    const walk = (item: unknown, sensitive = false): unknown => {
      if (typeof item === 'string') return /^https?:\/\//i.test(item) ? this.url(item) : this.text(item);
      if (Array.isArray(item)) return item.map(child => walk(child, sensitive));
      if (!isRecord(item)) return item;
      const privateValue = sensitive || typeof item.name === 'string' && this.sensitive(item.name);
      return Object.fromEntries(Object.entries(item).map(([key, child]) => {
        if (['properties', 'schemas', 'definitions'].includes(key) && isRecord(child)) return [key, Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, walk(schema, this.sensitive(name))]))];
        if (['example', 'default', 'const'].includes(key)) return [key, privateValue ? REDACTED : this.clean(child)];
        if (key === 'enum' && Array.isArray(child)) return [key, privateValue ? child.map(() => REDACTED) : this.clean(child)];
        if (key === 'examples') return [key, privateValue ? Array.isArray(child) ? child.map(() => REDACTED) : Object.fromEntries(Object.keys(isRecord(child) ? child : {}).map(name => [name, { value: REDACTED }])) : this.clean(child)];
        if (key === 'preset') return [key, this.clean(child)];
        return [key, walk(child, privateValue)];
      }));
    };
    return walk(value) as T;
  }
}
