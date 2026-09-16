import { ApigoError } from '../core/errors.js';
import type { ApiRecord, HttpResponse, Operation, RequestOptions } from '../core/types.js';
import type { ExecutionOptions, RequestPlan, RequestRunner } from '../core/runner.js';
import type { Store } from '../storage/database.js';
import { slug } from '../utils/objects.js';

export class CollectionService {
  constructor(private readonly store: Store) {}
  list(api: ApiRecord) { return this.store.collections(api.id); }
  get(api: ApiRecord, name: string) {
    const collection = this.list(api).find(item => item.name === slug(name));
    if (!collection) throw new ApigoError('COLLECTION_NOT_FOUND', `Collection not found: ${name}.`);
    return collection;
  }
  operations(api: ApiRecord, name: string): Operation[] {
    const collection = this.get(api, name);
    return api.definition.operations.filter(operation => collection.operations.includes(operation.key));
  }
  async prepare(api: ApiRecord, name: string, runner: RequestRunner, overrides: RequestOptions, execution: ExecutionOptions): Promise<RequestPlan[]> {
    const plans: RequestPlan[] = [];
    for (const operation of this.operations(api, name)) {
      const options = { ...overrides,
        params: Object.fromEntries(Object.entries(overrides.params ?? {}).filter(([name]) => operation.parameters.some(parameter => parameter.in === 'path' && parameter.name === name))),
        values: Object.fromEntries(Object.entries(overrides.values ?? {}).filter(([name]) => operation.parameters.some(parameter => parameter.name === name))),
      };
      if (['GET', 'HEAD'].includes(operation.method)) delete options.body;
      plans.push(await runner.prepare({ kind: 'operation', apiId: api.id, operation: operation.key, options }, { ...execution, yes: true }));
    }
    return plans;
  }
  needsConfirmation(plans: RequestPlan[]): boolean { return plans.some(plan => !['GET', 'HEAD', 'OPTIONS'].includes(plan.request.method)); }
  async execute(plans: RequestPlan[], runner: RequestRunner, continueOnError = false): Promise<CollectionResult[]> {
    const results: CollectionResult[] = [];
    for (const plan of plans) {
      try {
        const response = await runner.execute(plan);
        results.push({ operation: plan.recipe.operation!, response });
        if (response.status >= 400 && !continueOnError) break;
      } catch (error) {
        if (!(error instanceof ApigoError)) throw error;
        results.push({ operation: plan.recipe.operation!, error: { code: error.code, message: error.message, exitCode: error.exitCode } });
        if (!continueOnError) break;
      }
    }
    return results;
  }
}

export interface CollectionResult { operation: string; response?: HttpResponse; error?: { code: string; message: string; exitCode: number } }
