import type { Command } from 'commander';
import { ApigoError } from '../../core/errors.js';
import { findOperation } from '../../core/operation.js';
import { generateBody } from '../../openapi/generator.js';
import { apiSummary, renderApi, renderOperation, renderSchema, table } from '../../output/render.js';
import { context } from '../context.js';
import { options, requestOptions, toOutputOptions, toRequestOptions } from '../options.js';
import { loading, present } from '../presentation.js';
import { renderDiff } from '../../output/diff.js';
import { canPrompt, confirmAction, requestPrompts } from '../prompts.js';
import { machineOutput, responseValue } from '../../output/response.js';

export function importOptions(command: Command, withName = true): Command {
  if (withName) command.option('--name <name>', 'local API name');
  return command
    .option('-H, --header <name:value>', 'specification request header (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
    .option('--timeout <ms>', 'specification request timeout')
    .option('--no-verify', 'skip TLS certificate verification for this import')
    .option('--allow-external', 'allow remote refs on other origins or local refs outside the source directory');
}

export function registerApis(program: Command): void {
  importOptions(program.command('openapi <source>').description('Import OpenAPI or Swagger from a URL, JSON file, or YAML file'))
    .action(async (source: string, _raw, command: Command) => {
      const app = context(command); const raw = options(command); const input = await toRequestOptions(raw);
      app.redactor.collect(input.headers);
      const api = await loading(command, 'Loading OpenAPI specification', () => app.apis.import(source, raw.name as string | undefined,
        { headers: input.headers, timeout: input.timeout ?? app.config.get('timeout'), verify: input.verify ?? app.config.get('verify'), allowExternal: Boolean(raw.allowExternal) }));
      present(command, app, apiSummary(api), () => renderApi(api, app.redactor));
    });
  const api = program.command('api').description('Browse and manage imported APIs');
  api.command('list').action((_raw, command: Command) => {
    const app = context(command); const apis = app.apis.list().map(apiSummary);
    present(command, app, apis, () => `APIs\n\n${table(['NAME', 'SPEC', 'ENDPOINTS', 'SCHEMAS', 'SOURCE'], apis.map(item => [item.name, item.specVersion, item.endpoints, item.schemas, app.redactor.url(item.source)]))}`);
  });
  api.command('show [name]').option('--operation <name>', 'show parameter and response details for an operation')
    .action((name: string | undefined, _raw, command: Command) => {
      const app = context(command); const raw = options(command); const selected = app.apis.select(name ?? raw.api as string | undefined);
      const operation = typeof raw.operation === 'string' ? findOperation(selected.definition, raw.operation) : undefined;
      present(command, app, operation ?? { ...apiSummary(selected), operations: selected.definition.operations, securitySchemes: selected.definition.securitySchemes }, () => operation ? renderOperation(operation, selected, app.redactor) : renderApi(selected, app.redactor), true);
    });
  api.command('use <name>').action((name: string, _raw, command: Command) => {
    const app = context(command); const selected = app.apis.use(name);
    present(command, app, { activeApi: selected.name }, () => `Using API ${selected.name}.\n`);
  });
  api.command('remove <name>').action((name: string, _raw, command: Command) => {
    const app = context(command); app.apis.remove(name);
    present(command, app, { removed: name }, () => `Removed API ${name}.\n`);
  });
  importOptions(api.command('refresh [name]').description('Reload a specification and preserve environments and saved overrides'), false)
    .action(async (name: string | undefined, _raw, command: Command) => {
      const app = context(command); const raw = options(command); const input = await toRequestOptions(raw); app.redactor.collect(input.headers);
      const result = await loading(command, 'Refreshing OpenAPI specification', () => app.apis.refresh(name ?? raw.api as string | undefined,
        { headers: input.headers, timeout: input.timeout ?? app.config.get('timeout'), verify: input.verify ?? app.config.get('verify'), allowExternal: Boolean(raw.allowExternal) }));
      present(command, app, { api: apiSummary(result.api), diff: result.diff }, () => renderDiff(result.diff));
    });
  importOptions(api.command('diff [name]').description('Inspect the last refresh, or compare with the source before the first refresh'), false)
    .option('--remote', 'compare the current local API with its source without updating it')
    .option('--check', 'exit with code 1 if potentially breaking changes are detected')
    .action(async (name: string | undefined, _raw, command: Command) => {
      const app = context(command); const raw = options(command); const input = await toRequestOptions(raw); app.redactor.collect(input.headers);
      const diff = await loading(command, 'Comparing OpenAPI specifications', () => app.apis.diff(name ?? raw.api as string | undefined, Boolean(raw.remote),
        { headers: input.headers, timeout: input.timeout ?? app.config.get('timeout'), verify: input.verify ?? app.config.get('verify'), allowExternal: Boolean(raw.allowExternal) }));
      present(command, app, diff, () => renderDiff(diff));
      if (raw.check && diff.breaking) process.exitCode = 1;
    });

  const schema = program.command('schema').description('Inspect schemas and generate request examples');
  schema.command('list').action((_raw, command: Command) => {
    const app = context(command); const selected = app.apis.select(options(command).api as string | undefined); const names = Object.keys(selected.definition.schemas).sort();
    present(command, app, names, () => table(['SCHEMA'], names.map(name => [name])));
  });
  schema.command('show <name>').option('--example', 'generate a request body from the schema').option('--required-only', 'include only required request fields in examples')
    .action((name: string, _raw, command: Command) => {
      const app = context(command); const raw = options(command); const selected = app.apis.select(raw.api as string | undefined);
      const model = selected.definition.schemas[name];
      if (model === undefined) throw new ApigoError('SCHEMA_NOT_FOUND', `Schema not found: ${name}.`);
      const data = raw.example ? generateBody(model, selected.definition.document, { requiredOnly: Boolean(raw.requiredOnly) }) : model;
      present(command, app, data, () => raw.example ? `${JSON.stringify(raw.showSensitive ? data : app.redactor.clean(data), null, 2)}\n` : renderSchema(name, raw.showSensitive ? model : app.redactor.metadata(model), selected), !raw.example);
    });

  const collection = program.command('collection').description('Browse and execute endpoint groups');
  collection.command('list').action((_raw, command: Command) => {
    const app = context(command); const selected = app.apis.select(options(command).api as string | undefined); const collections = app.collections.list(selected);
    present(command, app, collections, () => table(['COLLECTION', 'LABEL', 'ENDPOINTS'], collections.map(item => [item.name, item.label, item.operations.length])));
  });
  collection.command('show <name>').action((name: string, _raw, command: Command) => {
    const app = context(command); const selected = app.apis.select(options(command).api as string | undefined); const operations = app.collections.operations(selected, name);
    present(command, app, operations, () => table(['OPERATION', 'METHOD', 'PATH', 'SUMMARY'], operations.map(item => [item.key, item.method, item.path, item.summary ?? ''])));
  });
  requestOptions(collection.command('run <name>').description('Preflight every request, then run sequentially; writes require --yes in CI'))
    .option('--continue-on-error', 'continue after HTTP or network failures')
    .action(async (name: string, _raw, command: Command) => {
      const app = context(command); const raw = options(command); const output = toOutputOptions(raw);
      if (output.raw || output.status || output.headers || output.bodyOnly) throw new ApigoError('OUTPUT_MODE', 'Collection output supports default tables or --json.');
      const interactive = canPrompt(Boolean(raw.nonInteractive), machineOutput(output));
      const api = app.apis.select(raw.api as string | undefined);
      const plans = await app.collections.prepare(api, name, app.runner, await toRequestOptions(raw), {
        environment: raw.env as string | undefined, dryRun: Boolean(raw.dryRun), prompts: interactive ? requestPrompts(app.redactor) : undefined,
      });
      if (raw.dryRun) {
        const data = plans.map(plan => ({ operation: plan.recipe.operation, ...plan.request,
          url: raw.showSensitive ? plan.request.url : app.redactor.url(plan.request.url), body: plan.request.body === undefined ? undefined : raw.showSensitive ? plan.request.body : app.redactor.body(plan.request.body) }));
        present(command, app, data, () => table(['OPERATION', 'METHOD', 'URL'], data.map(item => [item.operation, item.method, item.url])));
        return;
      }
      if (app.collections.needsConfirmation(plans) && !raw.yes) {
        if (!interactive) throw new ApigoError('CONFIRMATION_REQUIRED', 'This collection contains requests that can change data.', 2, 'Review with --dry-run, then pass --yes to execute it.');
        process.stderr.write(table(['OPERATION', 'METHOD', 'URL'], plans.map(plan => [plan.recipe.operation, plan.request.method, app.redactor.url(plan.request.url)])));
        if (!await confirmAction(`Send ${plans.length} requests, including writes?`)) throw new ApigoError('CANCELLED', 'Collection cancelled.', 130);
      }
      const results = await app.collections.execute(plans, app.runner, Boolean(raw.continueOnError));
      const data = results.map(item => ({ operation: item.operation, ...(item.response ? { status: item.response.status, duration: item.response.timings.totalMs, body: responseValue(item.response, app.redactor, Boolean(raw.showSensitive)) } : { error: item.error }) }));
      present(command, app, data, () => table(['OPERATION', 'STATUS', 'TIME'], results.map(item => [item.operation, item.response?.status ?? item.error?.code, item.response ? `${item.response.timings.totalMs}ms` : '—'])));
      const failed = results.find(item => item.error || (item.response?.status ?? 0) >= 400);
      if (failed) process.exitCode = failed.error?.exitCode ?? 1;
    });
}
