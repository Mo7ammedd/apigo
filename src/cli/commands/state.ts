import type { Command } from 'commander';
import { input } from '@inquirer/prompts';
import { ApigoError } from '../../core/errors.js';
import type { Credential, Secret } from '../../auth/service.js';
import type { AppContext } from '../context.js';
import { context } from '../context.js';
import { canPrompt, secretPrompt } from '../prompts.js';
import { options, pairs } from '../options.js';
import { present } from '../presentation.js';
import { table } from '../../output/render.js';
import { isSensitiveKey, REDACTED } from '../../utils/security.js';

async function stdinValue(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array); bytes += buffer.length;
    if (bytes > 64 * 1024) throw new ApigoError('INPUT_TOO_LARGE', 'Credential input exceeds 64 KB.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function authScope(app: AppContext, raw: Record<string, unknown>): { scope: string; label: string } {
  if (raw.global) return { scope: '*', label: 'global requests (explicit --auth)' };
  if (raw.api || app.apis.list().length) {
    const api = app.apis.select(raw.api as string | undefined);
    if (typeof raw.scheme === 'string' && raw.scheme !== 'default' && !Object.hasOwn(api.definition.securitySchemes, raw.scheme)) throw new ApigoError('AUTH_SCHEME', `Security scheme not found: ${raw.scheme}.`);
    return { scope: api.id, label: api.name };
  }
  return { scope: '*', label: 'global requests (explicit --auth)' };
}

async function credentialInput(raw: Record<string, unknown>, key: 'token' | 'username' | 'password'): Promise<Secret> {
  const literal = raw[key]; const reference = raw[`${key}Env`]; const stdin = key === 'token' && raw.tokenStdin;
  if ([literal !== undefined, reference !== undefined, Boolean(stdin)].filter(Boolean).length > 1) throw new ApigoError('AUTH_CONFIG', `Provide ${key} through only one input source.`);
  if (typeof reference === 'string') return { env: reference };
  if (typeof literal === 'string') return { value: literal };
  if (stdin) return { value: await stdinValue() };
  if (!canPrompt(Boolean(raw.nonInteractive), Boolean(raw.json))) throw new ApigoError('MISSING_INPUT', `A ${key} is required.`, 2, `Use --${key}-env NAME${key === 'token' ? ' or --token-stdin' : ''}.`);
  return { value: key === 'username' ? await input({ message: 'Username:' }, { input: process.stdin, output: process.stderr }) : await secretPrompt(key === 'token' ? 'Token / API key:' : 'Password:') };
}

export function registerState(program: Command): void {
  const env = program.command('env').description('Manage encrypted local environments');
  env.command('list').action((_raw, command: Command) => {
    const app = context(command); const environments = app.environments.list();
    present(command, app, environments, () => table(['', 'ENVIRONMENT', 'VARIABLES'], environments.map(item => [item.active ? '*' : '', item.name, item.variables])));
  });
  env.command('create <name>').option('-s, --set <name=value>', 'initial variable (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
    .action((name: string, _raw, command: Command) => {
      const app = context(command); const values = pairs(options(command).set as string[], '=');
      app.redactor.collect(values); app.environments.create(name, values);
      present(command, app, { created: name, variables: Object.keys(values) }, () => `Created environment ${name}.\n`);
    });
  env.command('use <name>').action((name: string, _raw, command: Command) => {
    const app = context(command); app.environments.use(name);
    present(command, app, { activeEnvironment: name }, () => `Using environment ${name}.\n`);
  });
  env.command('show [name]').action((name: string | undefined, _raw, command: Command) => {
    const app = context(command); const raw = options(command); const environment = app.environments.get(name ?? raw.env as string | undefined);
    const values = raw.showSensitive ? environment.values : Object.fromEntries(Object.keys(environment.values).map(key => [key, REDACTED]));
    present(command, app, { name: environment.name, values }, () => `${environment.name}\n\n${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  });
  env.command('set <environment> <key> [value]').option('--from-env <name>', 'read the value from a process environment variable').option('--stdin', 'read the value from standard input')
    .action(async (name: string, key: string, literal: string | undefined, _raw, command: Command) => {
      const app = context(command); const raw = options(command);
      if ([literal !== undefined, raw.fromEnv !== undefined, Boolean(raw.stdin)].filter(Boolean).length > 1) throw new ApigoError('ENV_INPUT', 'Provide a value through only one input source.');
      let value = literal;
      if (typeof raw.fromEnv === 'string') {
        value = process.env[raw.fromEnv];
        if (value === undefined) throw new ApigoError('ENV_MISSING', `Process environment variable ${raw.fromEnv} is not set.`);
      } else if (raw.stdin) value = await stdinValue();
      if (value === undefined) {
        if (!canPrompt(Boolean(raw.nonInteractive), Boolean(raw.json))) throw new ApigoError('MISSING_INPUT', 'Provide a value, --from-env NAME, or --stdin.');
        value = isSensitiveKey(key) ? await secretPrompt(`${key}:`) : await input({ message: `${key}:` }, { input: process.stdin, output: process.stderr });
      }
      if (key !== 'BASE_URL') app.redactor.add(value);
      app.environments.set(name, key, value);
      present(command, app, { environment: name, variable: key, updated: true }, () => `Set ${key} in ${name}.\n`);
    });
  env.command('unset <environment> <key>').action((name: string, key: string, _raw, command: Command) => {
    const app = context(command); app.environments.unset(name, key);
    present(command, app, { environment: name, removed: key }, () => `Removed ${key} from ${name}.\n`);
  });
  env.command('delete <name>').action((name: string, _raw, command: Command) => {
    const app = context(command); app.environments.remove(name);
    present(command, app, { removed: name }, () => `Deleted environment ${name}.\n`);
  });

  const auth = program.command('auth').description('Configure Bearer, Basic, API key, or existing OAuth2 tokens');
  auth.command('set <type>').option('--global', 'configure authentication for direct HTTP requests with --auth')
    .option('--scheme <name>', 'OpenAPI security scheme (supports AND requirements)', 'default')
    .option('--token <value>', 'token or API key (prefer --token-env or --token-stdin)')
    .option('--token-env <name>', 'resolve the token from a process/environment variable at request time')
    .option('--token-stdin', 'read the token from standard input')
    .option('--username <value>', 'Basic authentication username').option('--username-env <name>', 'resolve the username from a process/environment variable')
    .option('--password <value>', 'Basic authentication password (prefer --password-env)').option('--password-env <name>', 'resolve the password from a process/environment variable')
    .option('--name <name>', 'API key header/query/cookie name for direct requests')
    .option('--in <location>', 'API key location: header, query, cookie').option('--scopes <scopes>', 'comma-separated OAuth2 scopes (metadata only)')
    .action(async (type: string, _raw, command: Command) => {
      if (!['bearer', 'basic', 'apikey', 'oauth2'].includes(type)) throw new ApigoError('AUTH_TYPE', 'Authentication type must be bearer, basic, apikey, or oauth2.');
      const app = context(command); const raw = options(command); const { scope, label } = authScope(app, raw);
      const credential: Credential = { type: type as Credential['type'] };
      if (type === 'basic') { credential.username = await credentialInput(raw, 'username'); credential.password = await credentialInput(raw, 'password'); }
      else {
        if (raw.token === undefined && raw.tokenEnv === undefined && !raw.tokenStdin) {
          const selected = (raw.env as string | undefined) ?? app.config.get('activeEnvironment');
          if (selected && app.environments.get(selected).values.TOKEN !== undefined) credential.token = { value: '{{TOKEN}}' };
        }
        credential.token ??= await credentialInput(raw, 'token');
      }
      if (raw.name) credential.name = String(raw.name);
      if (raw.in) credential.in = raw.in as Credential['in'];
      if (raw.scopes) credential.scopes = String(raw.scopes).split(',').map(value => value.trim());
      app.auth.set(scope, String(raw.scheme), credential);
      present(command, app, { configured: type, scope: label, scheme: raw.scheme }, () => `Configured ${type} authentication for ${label}.\n`);
    });
  auth.command('show').option('--global', 'show global authentication configuration').action((_raw, command: Command) => {
    const app = context(command); const raw = options(command); const { scope } = authScope(app, raw); const profiles = app.auth.list(scope);
    present(command, app, profiles, () => table(['SCHEME', 'TYPE', 'CREDENTIAL SOURCE'], profiles.map(profile => [profile.scheme, profile.credential.type, raw.showSensitive ? JSON.stringify(profile.credential) : profile.credential.token?.env ? `environment: ${profile.credential.token.env}` : 'encrypted locally'])));
  });
  auth.command('clear').option('--global', 'clear global credentials').option('--scheme <name>', 'clear only this security scheme').action((_raw, command: Command) => {
    const app = context(command); const raw = options(command); const { scope, label } = authScope(app, raw);
    app.auth.remove(scope, raw.scheme as string | undefined);
    present(command, app, { cleared: label }, () => `Cleared authentication for ${label}.\n`);
  });

  const config = program.command('config').description('Inspect and change local configuration');
  config.command('list').action((_raw, command: Command) => {
    const app = context(command); const settings = app.config.list();
    present(command, app, settings, () => table(['KEY', 'VALUE'], Object.entries(settings)));
  });
  config.command('get <key>').action((key: string, _raw, command: Command) => {
    const app = context(command); const settings = app.config.list();
    if (!Object.hasOwn(settings, key)) throw new ApigoError('CONFIG_KEY', `Unknown configuration key: ${key}.`);
    const value = settings[key as keyof typeof settings];
    present(command, app, value, () => `${String(value)}\n`);
  });
  config.command('set <key> <value>').action((key: string, rawValue: string, _raw, command: Command) => {
    const app = context(command); let value: unknown = rawValue;
    try { value = JSON.parse(rawValue); } catch { /* String configuration value. */ }
    if (key === 'activeApi' && typeof value === 'string') value = app.apis.select(value).id;
    if (key === 'activeEnvironment' && typeof value === 'string') app.environments.get(value);
    app.config.set(key, value);
    present(command, app, { setting: key, value }, () => `Set ${key}.\n`);
  });
  config.command('reset').action((_raw, command: Command) => {
    const app = context(command); app.config.reset();
    present(command, app, { reset: true }, () => 'Configuration reset to defaults.\n');
  });
}
