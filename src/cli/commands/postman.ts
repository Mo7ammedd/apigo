import type { Command } from 'commander';
import { PostmanService } from '../../postman/service.js';
import { writePostman } from '../../postman/exporter.js';
import { apiSummary, renderApi } from '../../output/render.js';
import { context } from '../context.js';
import { options } from '../options.js';
import { loading, present } from '../presentation.js';

export function registerPostman(program: Command): void {
  const importer = program.command('import').description('Import another API client format');
  importer.command('postman <file>').description('Import a Postman v2 collection').option('--name <name>', 'local API name')
    .action(async (file: string, _raw, command: Command) => {
      const app = context(command); const raw = options(command);
      const service = new PostmanService(app.apis, app.environments);
      const result = await loading(command, 'Importing Postman collection', () => service.import(file, raw.name as string | undefined));
      present(command, app, { ...apiSummary(result.api), environment: result.environment, warnings: result.warnings },
        () => `${renderApi(result.api, app.redactor)}${result.environment ? `\nVariables imported into environment ${result.environment}.\n` : ''}${result.warnings.map(warning => `\n${warning}`).join('')}\n`);
    });
  const exporter = program.command('export').description('Export an API collection');
  exporter.command('postman <file>').description('Export Postman v2.1 with credential placeholders').option('--force', 'replace an existing export file')
    .action(async (file: string, _raw, command: Command) => {
      const app = context(command); const raw = options(command); const api = app.apis.select(raw.api as string | undefined);
      await writePostman(api.definition, file, Boolean(raw.force));
      present(command, app, { exported: file, endpoints: api.definition.operations.length }, () => `Exported ${api.definition.operations.length} requests to ${file}.\n`);
    });
}
