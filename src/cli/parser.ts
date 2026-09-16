import { Command } from 'commander';
import chalk from 'chalk';
import pkg from '../../package.json' with { type: 'json' };
import { commandRedactor } from './context.js';
import { terminalSafe } from '../utils/security.js';
import { registerRequests } from './commands/requests.js';
import { registerApis } from './commands/apis.js';
import { registerState } from './commands/state.js';
import { registerPostman } from './commands/postman.js';

export function createProgram(): Command {
  const program = new Command();
  program.name('apigo').description('An OpenAPI-native API client for your terminal.').version(pkg.version)
    .option('--json', 'machine-readable JSON output')
    .option('--show-sensitive', 'explicitly show sensitive values in output')
    .option('--no-color', 'disable terminal colors')
    .option('--debug', 'include a sanitized stack trace on errors')
    .option('--non-interactive', 'never prompt; report missing input as an error')
    .option('--config-dir <path>', 'override local storage directory (or APIGO_HOME)')
    .option('--api <name>', 'select an imported API')
    .option('--env <name>', 'select an environment for this command')
    .configureOutput({ writeErr: message => process.stderr.write(terminalSafe(commandRedactor.text(message))) })
    .showHelpAfterError()
    .exitOverride();
  program.hook('preAction', () => { if (program.opts().color === false) chalk.level = 0; });
  registerRequests(program);
  registerApis(program);
  registerState(program);
  registerPostman(program);
  program.addHelpText('after', '\nQuick start:\n  apigo openapi https://localhost:7043/swagger/v1/swagger.json\n  apigo run vehicles.list\n  apigo run vehicles.get --id 42\n\nUse --json, --body, --raw, --headers, or --status for shell scripting.\n');
  return program;
}
