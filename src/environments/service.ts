import { ApigoError } from '../core/errors.js';
import type { ConfigService } from '../config/service.js';
import type { Store } from '../storage/database.js';
import type { Redactor } from '../utils/security.js';
import { validateName } from '../utils/objects.js';
import { interpolate } from './interpolation.js';
import type { Variables } from './interpolation.js';

export class EnvironmentService {
  constructor(private readonly store: Store, private readonly config: ConfigService) {}
  list(): { name: string; active: boolean; variables: number }[] {
    return this.store.environmentNames().map(name => ({ name, active: name === this.config.get('activeEnvironment'), variables: Object.keys(this.store.environment(name) ?? {}).length }));
  }
  get(name?: string): { name: string; values: Variables } {
    const selected = name ?? this.config.get('activeEnvironment');
    if (!selected) throw new ApigoError('ENV_NOT_SELECTED', 'No environment is selected.', 2, 'Use apigo env create local, then apigo env use local.');
    const values = this.store.environment(selected);
    if (!values) throw new ApigoError('ENV_NOT_FOUND', `Environment not found: ${selected}.`);
    return { name: selected, values };
  }
  create(name: string, values: Variables = {}): void {
    validateName(name, 'Environment name');
    if (this.store.environment(name)) throw new ApigoError('ENV_EXISTS', `Environment already exists: ${name}.`);
    for (const key of Object.keys(values)) this.validateKey(key);
    this.store.putEnvironment(name, values);
    if (!this.config.get('activeEnvironment')) this.use(name);
  }
  set(name: string, key: string, value: string): void {
    this.validateKey(key);
    const environment = this.get(name);
    this.store.putEnvironment(name, { ...environment.values, [key]: value });
  }
  unset(name: string, key: string): void {
    const environment = this.get(name);
    delete environment.values[key];
    this.store.putEnvironment(name, environment.values);
  }
  use(name: string): void { this.get(name); this.config.set('activeEnvironment', name); }
  remove(name: string): void { this.get(name); this.store.removeEnvironment(name); if (this.config.get('activeEnvironment') === name) this.config.set('activeEnvironment', null); }
  values(name: string | undefined, redactor: Redactor): Variables {
    if (!name && !this.config.get('activeEnvironment')) return {};
    const stored = this.get(name).values;
    // Process variables enter explicitly through `env set --from-env` or auth references.
    const expanded = interpolate(stored, stored);
    for (const [key, value] of Object.entries(expanded)) if (key !== 'BASE_URL') redactor.add(value);
    return expanded;
  }
  private validateKey(key: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new ApigoError('ENV_KEY', 'Environment keys must start with a letter or underscore and contain letters, numbers, dots, underscores, or hyphens.');
  }
}
