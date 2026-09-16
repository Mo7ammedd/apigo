import type { ApiService } from '../core/api.js';
import type { EnvironmentService } from '../environments/service.js';
import { loadPostman } from './importer.js';

export class PostmanService {
  constructor(private readonly apis: ApiService, private readonly environments: EnvironmentService) {}
  async import(source: string, name?: string) {
    const imported = await loadPostman(source);
    const api = this.apis.persist(imported.definition, name);
    let environment: string | undefined;
    if (Object.keys(imported.variables).length) {
      environment = `${api.name.slice(0, 70)}-postman`;
      const existing = this.environments.list().find(item => item.name === environment);
      if (!existing) this.environments.create(environment, imported.variables);
      else {
        const values = this.environments.get(environment).values;
        for (const [key, value] of Object.entries(imported.variables)) if (!Object.hasOwn(values, key)) this.environments.set(environment, key, value);
      }
      this.environments.use(environment);
    }
    return { api, environment, warnings: imported.warnings };
  }
}
