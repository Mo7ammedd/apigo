import type { Command } from 'commander';
import { ApigoError } from '../../core/errors.js';
import type { HttpMethod, RequestRecipe } from '../../core/types.js';
import { mergeOptions } from '../../core/request.js';
import { formatResponse, formatVerbose, machineOutput } from '../../output/response.js';
import { renderHistory, table } from '../../output/render.js';
import { context } from '../context.js';
import { canPrompt, requestPrompts } from '../prompts.js';
import { present } from '../presentation.js';
import { options, requestOptions, toOutputOptions, toRequestOptions } from '../options.js';

export async function executeRecipe(command: Command, recipe: RequestRecipe): Promise<void> {
  const app = context(command);
  const raw = options(command);
  const output = toOutputOptions(raw);
  const prompts = canPrompt(Boolean(raw.nonInteractive), machineOutput(output)) ? requestPrompts(app.redactor) : undefined;
  const plan = await app.runner.prepare(recipe, { environment: raw.env as string | undefined, prompts, yes: Boolean(raw.yes), dryRun: Boolean(raw.dryRun) });
  if (raw.dryRun) {
    let body: unknown = plan.request.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* Plain text body. */ } }
    const data = { method: plan.request.method, url: output.showSensitive ? plan.request.url : app.redactor.url(plan.request.url),
      headers: plan.request.headers, body, timeout: plan.request.timeout, verify: plan.request.verify, followRedirects: plan.request.followRedirects };
    present(command, app, data, () => formatVerbose(plan.request, undefined, app.redactor, output.showSensitive));
    return;
  }
  try {
    const response = await app.runner.execute(plan);
    if (output.verbose) process.stderr.write(formatVerbose(plan.request, response, app.redactor, output.showSensitive));
    process.stdout.write(formatResponse(plan.request, response, output, app.redactor));
    if (response.status >= 400) process.exitCode = 1;
  } catch (error) {
    if (output.verbose) process.stderr.write(formatVerbose(plan.request, undefined, app.redactor, output.showSensitive));
    if (error instanceof ApigoError) throw new ApigoError(error.code, `${error.message}\n${app.redactor.url(plan.request.url)}`, error.exitCode, error.hint);
    throw error;
  }
}

export function registerRequests(program: Command): void {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as HttpMethod[]) {
    requestOptions(program.command(method.toLowerCase()).argument('<url>').description(`Send an HTTP ${method} request`))
      .action(async (url: string, _raw, command: Command) => executeRecipe(command, { kind: 'http', method, url, options: await toRequestOptions(options(command)) }));
  }
  requestOptions(program.command('run <operation>').description('Run an OpenAPI operation or saved request').allowUnknownOption().allowExcessArguments())
    .addHelpText('after', '\nOpenAPI parameters: --id 42 --page 1 --limit 20\nUse -p name=value or -q name=value for parameters that collide with CLI flags.\n')
    .action(async (name: string, _raw, command: Command) => {
      const raw = options(command);
      const app = context(command);
      const overrides = await toRequestOptions(raw, command.args.slice(1));
      await executeRecipe(command, app.runner.recipe(name, overrides, raw.api as string | undefined));
    });

  requestOptions(program.command('save <name> [operation]').description('Save the last request or an operation with overrides'))
    .option('--force', 'replace an existing saved request')
    .action(async (name: string, operation: string | undefined, _raw, command: Command) => {
      const app = context(command);
      const raw = options(command);
      const overrides = await toRequestOptions(raw);
      const recipe = operation ? app.runner.recipe(operation, overrides, raw.api as string | undefined) : app.history.latest().recipe;
      recipe.options = mergeOptions(recipe.options, overrides);
      if (recipe.apiId && app.apis.select(recipe.apiId).definition.operations.some(item => item.key === name)) throw new ApigoError('SAVED_NAME', 'Choose a saved request name that does not shadow an operation.');
      const saved = app.history.save(name, recipe, Boolean(raw.force));
      present(command, app, saved, () => `Saved ${name}. Run it with apigo run ${name}.\n`);
    });

  const saved = program.command('saved').description('Manage saved requests');
  saved.command('list').action((_raw, command: Command) => {
    const app = context(command); const names = app.store.savedNames();
    present(command, app, names, () => table(['SAVED REQUEST'], names.map(name => [name])));
  });
  saved.command('show <name>').action((name: string, _raw, command: Command) => {
    const app = context(command); const request = app.store.saved(name);
    if (!request) throw new ApigoError('SAVED_NOT_FOUND', `Saved request not found: ${name}.`);
    present(command, app, request, () => `${JSON.stringify(app.redactor.clean(request), null, 2)}\n`);
  });
  saved.command('remove <name>').action((name: string, _raw, command: Command) => {
    const app = context(command);
    if (!app.store.saved(name)) throw new ApigoError('SAVED_NOT_FOUND', `Saved request not found: ${name}.`);
    app.store.removeSaved(name); present(command, app, { removed: name }, () => `Removed saved request ${name}.\n`);
  });

  const history = program.command('history').description('Browse and replay redacted request history').option('-l, --limit <count>', 'maximum entries to list', '20');
  history.action((_raw, command: Command) => {
    const app = context(command); const limit = Number(options(command).limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new ApigoError('VALIDATION', 'History limit must be between 1 and 10000.');
    const entries = app.history.list(limit);
    present(command, app, entries, () => table(['ID', 'METHOD', 'OPERATION', 'STATUS', 'TIME'], entries.map(entry => [entry.id, entry.method, entry.operation ?? '(direct)', entry.status ?? 'failed', entry.duration == null ? '—' : `${entry.duration}ms`])));
  });
  history.command('show <id>').action((id: string, _raw, command: Command) => {
    const app = context(command); const entry = app.history.get(id);
    present(command, app, entry, () => renderHistory(entry));
  });
  requestOptions(history.command('run <id>').description('Replay with current authentication and optional overrides').allowUnknownOption().allowExcessArguments())
    .action(async (id: string, _raw, command: Command) => {
      const app = context(command); const recipe = app.history.get(id).recipe;
      recipe.options = mergeOptions(recipe.options, await toRequestOptions(options(command), command.args.slice(1)));
      await executeRecipe(command, recipe);
    });
  history.command('clear').action((_raw, command: Command) => {
    const app = context(command); const removed = app.history.clear();
    present(command, app, { removed }, () => `Cleared ${removed} history entries.\n`);
  });
}
