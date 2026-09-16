import { z } from 'zod';
import { ApigoError } from '../core/errors.js';
import type { Store } from '../storage/database.js';

const schema = z.object({
  timeout: z.number().int().min(1).max(600_000).default(30_000),
  verify: z.boolean().default(true),
  followRedirects: z.boolean().default(false),
  maxResponseBytes: z.number().int().min(1024).max(1024 * 1024 * 1024).default(10 * 1024 * 1024),
  historyLimit: z.number().int().min(0).max(100_000).default(1000),
  activeApi: z.string().nullable().default(null),
  activeEnvironment: z.string().nullable().default(null),
});
export type Settings = z.infer<typeof schema>;

export class ConfigService {
  constructor(private readonly store: Store) {}
  list(): Settings {
    const result = schema.safeParse(this.store.config());
    if (!result.success) throw new ApigoError('INVALID_CONFIG', 'Local configuration is invalid.', 2, 'Use apigo config reset to restore defaults.');
    return result.data;
  }
  get<K extends keyof Settings>(key: K): Settings[K] { return this.list()[key]; }
  set(key: string, value: unknown): void {
    if (!Object.hasOwn(schema.shape, key)) throw new ApigoError('CONFIG_KEY', `Unknown configuration key: ${key}.`, 2, 'Use apigo config list to see supported keys.');
    const result = schema.shape[key as keyof Settings].safeParse(value);
    if (!result.success) throw new ApigoError('CONFIG_VALUE', `Invalid value for configuration key ${key}.`);
    this.store.setConfig(key, result.data);
  }
  reset(): void { this.store.resetConfig(); }
}
