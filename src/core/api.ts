import { randomUUID } from 'node:crypto';
import { ApigoError } from './errors.js';
import type { ApiDefinition, ApiDiff, ApiRecord } from './types.js';
import type { ConfigService } from '../config/service.js';
import type { Store } from '../storage/database.js';
import { loadDocument } from '../openapi/loader.js';
import type { LoadOptions } from '../openapi/loader.js';
import { parseOpenApi } from '../openapi/parser.js';
import { slug, validateName } from '../utils/objects.js';
import { diffApis, hasChanges } from '../openapi/diff.js';

export class ApiService {
  constructor(private readonly store: Store, private readonly config: ConfigService) {}
  list(): ApiRecord[] { return this.store.listApis(); }
  select(name?: string): ApiRecord {
    const selected = name ?? this.config.get('activeApi');
    if (selected) {
      const api = this.store.getApi(selected);
      if (!api) throw new ApigoError('API_NOT_FOUND', `API not found: ${selected}.`, 2, 'Use apigo api list or import an OpenAPI specification.');
      return api;
    }
    const apis = this.list();
    if (apis.length === 1) return apis[0]!;
    throw new ApigoError('API_NOT_SELECTED', apis.length ? 'Select an API with --api or apigo api use.' : 'No APIs have been imported.', 2, 'Run apigo openapi <URL or file>.');
  }
  use(name: string): ApiRecord { const api = this.select(name); this.config.set('activeApi', api.id); return api; }
  remove(name: string): void {
    const api = this.select(name);
    this.store.removeApi(api.id);
    if (this.config.get('activeApi') === api.id) this.config.set('activeApi', null);
  }
  async import(source: string, name?: string, options: LoadOptions = {}): Promise<ApiRecord> {
    const loaded = await loadDocument(source, options);
    return this.persist(parseOpenApi(loaded.document, loaded.source), name);
  }
  private async fetch(api: ApiRecord, options: LoadOptions): Promise<ApiDefinition> {
    if (api.definition.kind !== 'openapi') throw new ApigoError('POSTMAN_REFRESH', 'Re-import the Postman source with apigo import postman.');
    const loaded = await loadDocument(api.definition.source, options);
    return parseOpenApi(loaded.document, loaded.source);
  }
  async refresh(name: string | undefined, options: LoadOptions = {}): Promise<{ api: ApiRecord; diff: ApiDiff }> {
    const api = this.select(name);
    const definition = await this.fetch(api, options);
    const diff = diffApis(api.definition, definition);
    const updated = { ...api, definition, updatedAt: new Date().toISOString(),
      ...(hasChanges(diff) ? { previous: api.definition, lastDiff: diff } : {}) };
    this.store.putApi(updated);
    return { api: updated, diff };
  }
  async diff(name: string | undefined, remote = false, options: LoadOptions = {}): Promise<ApiDiff> {
    const api = this.select(name);
    if (!remote && api.lastDiff) return api.lastDiff;
    return diffApis(api.definition, await this.fetch(api, options));
  }
  persist(definition: ApiDefinition, requestedName?: string): ApiRecord {
    const local = [definition.source, definition.baseUrl ?? ''].some(value => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(value));
    const name = validateName(requestedName ?? `${slug(definition.title.replace(/\s+api$/i, ''))}${local ? '-local' : ''}`, 'API name');
    const existing = this.store.getApi(name);
    if (existing && existing.definition.source !== definition.source) throw new ApigoError('API_EXISTS', `An API named ${name} already exists with another source.`, 2, 'Choose a different --name.');
    const now = new Date().toISOString();
    const diff = existing ? diffApis(existing.definition, definition) : undefined;
    const api: ApiRecord = { ...existing, id: existing?.id ?? randomUUID(), name, definition, createdAt: existing?.createdAt ?? now, updatedAt: now,
      ...(existing && diff && hasChanges(diff) ? { previous: existing.definition, lastDiff: diff } : {}) };
    this.store.putApi(api);
    this.config.set('activeApi', api.id);
    return api;
  }
}
