import { randomBytes } from 'node:crypto';
import { ApigoError } from '../core/errors.js';
import type { HistoryEntry, HttpResponse, PreparedRequest, RequestRecipe, SavedRequest } from '../core/types.js';
import type { Store } from '../storage/database.js';
import type { Redactor } from '../utils/security.js';
import { REDACTED } from '../utils/security.js';
import { validateName } from '../utils/objects.js';

const BODY_LIMIT = 64 * 1024;

export class HistoryService {
  constructor(private readonly store: Store, private readonly redactor: Redactor) {}
  list(limit = 20) { return this.store.history(limit); }
  get(id: string): HistoryEntry {
    if (!/^[a-f0-9]{1,24}$/.test(id)) throw new ApigoError('HISTORY_ID', 'History IDs contain hexadecimal characters.');
    const entry = this.store.historyEntry(id);
    if (!entry) throw new ApigoError('HISTORY_NOT_FOUND', 'History entry not found.');
    return entry;
  }
  latest(): HistoryEntry {
    const entry = this.store.history(1)[0];
    if (!entry) throw new ApigoError('HISTORY_EMPTY', 'There are no requests in history.', 2, 'Send a request first, or pass an operation to apigo save.');
    return this.get(entry.id);
  }
  clear(): number { return this.store.clearHistory(); }

  safeRecipe(recipe: RequestRecipe): RequestRecipe {
    if (recipe.apiId) for (const scheme of Object.values(this.store.getApi(recipe.apiId)?.definition.securitySchemes ?? {})) if (scheme.name) this.redactor.addName(scheme.name);
    this.redactor.collect(recipe.options);
    const safe = this.redactor.clean(recipe, true);
    safe.options.headers = Object.fromEntries(Object.entries(safe.options.headers ?? {}).filter(([key, value]) => !this.redactor.sensitive(key) || value.includes('{{')));
    for (const key of Object.keys(safe.options.query ?? {})) {
      if (this.redactor.sensitive(key) && !String(safe.options.query![key]).includes('{{')) delete safe.options.query![key];
    }
    if (safe.url) safe.url = this.redactor.url(safe.url, true);
    if (safe.options.body !== undefined && Buffer.byteLength(JSON.stringify(safe.options.body)) > BODY_LIMIT) safe.options.body = REDACTED;
    return safe;
  }

  record(recipe: RequestRecipe, request: PreparedRequest, limit: number, response?: HttpResponse, error?: ApigoError): HistoryEntry {
    const entry: HistoryEntry = {
      id: randomBytes(6).toString('hex'), createdAt: new Date().toISOString(), recipe: this.safeRecipe(recipe),
      request: { method: request.method, url: this.redactor.url(request.url), headers: this.redactor.headers(request.headers),
        ...(request.body === undefined ? {} : { body: Buffer.from(this.redactor.body(request.body)).subarray(0, BODY_LIMIT).toString('utf8') }) },
    };
    if (response) {
      let body = this.redactor.body(response.body);
      if (Buffer.byteLength(body) > BODY_LIMIT) { body = Buffer.from(body).subarray(0, BODY_LIMIT).toString('utf8'); entry.responseTruncated = true; }
      entry.response = { ...response, url: this.redactor.url(response.url), headers: this.redactor.headers(response.headers), body };
    }
    if (error) entry.error = { code: error.code, message: this.redactor.text(error.message) };
    this.store.addHistory(entry, limit);
    return entry;
  }

  save(name: string, recipe: RequestRecipe, force = false): SavedRequest {
    validateName(name, 'Saved request name');
    if (this.store.saved(name) && !force) throw new ApigoError('SAVED_EXISTS', `Saved request already exists: ${name}.`, 2, 'Use --force to replace it.');
    const saved = { name, recipe: this.safeRecipe(recipe), createdAt: new Date().toISOString() };
    this.store.save(saved);
    return saved;
  }
}
