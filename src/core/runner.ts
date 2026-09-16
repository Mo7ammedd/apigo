import { ApigoError } from './errors.js';
import type { ApiRecord, HttpResponse, Operation, PreparedRequest, PromptAdapter, RequestOptions, RequestRecipe } from './types.js';
import type { Store } from '../storage/database.js';
import type { ApiService } from './api.js';
import type { AuthService } from '../auth/service.js';
import type { EnvironmentService } from '../environments/service.js';
import type { ConfigService } from '../config/service.js';
import type { HistoryService } from '../history/service.js';
import type { Redactor } from '../utils/security.js';
import { interpolate } from '../environments/interpolation.js';
import { findOperation } from './operation.js';
import { prepareOperation } from './operation-request.js';
import { mergeOptions, prepareHttp } from './request.js';
import { sendRequest } from '../http/client.js';
import { containsRedaction } from '../utils/objects.js';

export interface ExecutionOptions { environment?: string; prompts?: PromptAdapter; yes?: boolean; dryRun?: boolean }
export interface RequestPlan { recipe: RequestRecipe; request: PreparedRequest; api?: ApiRecord; operation?: Operation }

export class RequestRunner {
  constructor(private readonly store: Store, private readonly apis: ApiService, private readonly environments: EnvironmentService,
    private readonly auth: AuthService, private readonly config: ConfigService, private readonly history: HistoryService,
    private readonly redactor: Redactor, private readonly warn: (message: string) => void = () => {}) {}

  recipe(name: string, overrides: RequestOptions = {}, apiName?: string): RequestRecipe {
    const saved = this.store.saved(name);
    if (saved) return { ...saved.recipe, ...(apiName ? { apiId: this.apis.select(apiName).id } : {}), options: mergeOptions(saved.recipe.options, overrides) };
    const api = this.apis.select(apiName);
    return { kind: 'operation', apiId: api.id, operation: findOperation(api.definition, name).key, options: overrides };
  }

  register(request: PreparedRequest): void {
    for (const name of [...request.sensitiveHeaders, ...request.sensitiveQuery, ...request.sensitiveCookies]) this.redactor.addName(name);
    this.redactor.collect(request.headers);
    for (const [key, value] of new URL(request.url).searchParams) if (this.redactor.sensitive(key)) this.redactor.add(value);
    if (request.body) {
      if (request.headers['content-type']?.includes('application/x-www-form-urlencoded')) this.redactor.collect(Object.fromEntries(new URLSearchParams(request.body)));
      else { try { this.redactor.collect(JSON.parse(request.body)); } catch { /* Text bodies still pass through known-secret filtering. */ } }
    }
  }

  async prepare(recipe: RequestRecipe, execution: ExecutionOptions = {}): Promise<RequestPlan> {
    const settings = this.config.list();
    const options = mergeOptions({ timeout: settings.timeout, verify: settings.verify, followRedirects: settings.followRedirects, maxResponseBytes: settings.maxResponseBytes }, recipe.options);
    const variables = this.environments.values(execution.environment, this.redactor);
    let plan: RequestPlan;
    let prompted = false;
    if (recipe.kind === 'operation') {
      const api = this.apis.select(recipe.apiId);
      const operation = findOperation(api.definition, recipe.operation!);
      for (const scheme of Object.values(api.definition.securitySchemes)) if (scheme.name) this.redactor.addName(scheme.name);
      const prepared = await prepareOperation(api.definition, operation, options, variables, execution.prompts);
      plan = { recipe: { ...recipe, operation: operation.key, options: prepared.options }, request: prepared.request, api, operation };
      prompted = prepared.prompted;
    } else {
      let url = interpolate(recipe.url!, variables);
      const input = interpolate(options, variables);
      if (!/^https?:\/\//i.test(url) && (input.baseUrl || variables.BASE_URL)) url = `${(input.baseUrl ?? variables.BASE_URL)!.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
      if (input.baseUrl && /^https?:\/\//i.test(url)) {
        const original = new URL(url);
        url = `${input.baseUrl.replace(/\/$/, '')}${original.pathname}${original.search}`;
      }
      plan = { recipe, request: prepareHttp(recipe.method!, url, input) };
    }
    if (plan.api) for (const scheme of Object.values(plan.api.definition.securitySchemes)) {
      if (scheme.name && scheme.in === 'query') plan.request.sensitiveQuery.push(scheme.name);
      if (scheme.name && scheme.in === 'header') plan.request.sensitiveHeaders.push(scheme.name.toLowerCase());
    }
    try { this.auth.apply(plan.request, plan.api, plan.operation, variables, options.noAuth, options.useAuth); }
    catch (error) {
      if (execution.dryRun && error instanceof ApigoError && ['AUTH_REQUIRED', 'AUTH_MISSING'].includes(error.code)) this.warn('Authentication is required before this request can be sent.');
      else throw error;
    }
    this.register(plan.request);
    if (containsRedaction(plan.request)) throw new ApigoError('REDACTED_INPUT', 'The saved request contains redacted data.', 2, 'Override the missing values before sending this request.');
    if (prompted && !execution.yes && !execution.dryRun && execution.prompts && !await execution.prompts.confirmRequest(plan.request)) throw new ApigoError('CANCELLED', 'Request cancelled.', 130);
    return plan;
  }

  async execute(plan: RequestPlan): Promise<HttpResponse> {
    let response: HttpResponse;
    try { response = await sendRequest(plan.request); }
    catch (error) {
      if (error instanceof ApigoError && !plan.recipe.options.noHistory) this.record(plan, undefined, error);
      throw error;
    }
    this.redactor.collect(response.headers);
    try { this.redactor.collect(JSON.parse(response.body)); } catch { /* Non-JSON data uses known-secret filtering. */ }
    if (!plan.recipe.options.noHistory) this.record(plan, response);
    return response;
  }

  private record(plan: RequestPlan, response?: HttpResponse, error?: ApigoError): void {
    try { this.history.record(plan.recipe, plan.request, this.config.get('historyLimit'), response, error); }
    catch { this.warn('Request completed, but history could not be written. Check local storage.'); }
  }
}
