import type { Command } from 'commander';
import { storagePaths } from '../config/paths.js';
import { Store } from '../storage/database.js';
import { ConfigService } from '../config/service.js';
import { ApiService } from '../core/api.js';
import { EnvironmentService } from '../environments/service.js';
import { AuthService } from '../auth/service.js';
import { HistoryService } from '../history/service.js';
import { CollectionService } from '../collections/service.js';
import { RequestRunner } from '../core/runner.js';
import { Redactor, terminalSafe } from '../utils/security.js';

export const commandRedactor = new Redactor();

export class AppContext {
  readonly store: Store;
  readonly config: ConfigService;
  readonly apis: ApiService;
  readonly environments: EnvironmentService;
  readonly auth: AuthService;
  readonly history: HistoryService;
  readonly collections: CollectionService;
  readonly runner: RequestRunner;

  constructor(directory?: string, readonly redactor = commandRedactor) {
    redactor.add(process.env.APIGO_SECRET_KEY);
    this.store = new Store(storagePaths(directory));
    this.config = new ConfigService(this.store);
    this.apis = new ApiService(this.store, this.config);
    this.environments = new EnvironmentService(this.store, this.config);
    this.auth = new AuthService(this.store, redactor);
    this.history = new HistoryService(this.store, redactor);
    this.collections = new CollectionService(this.store);
    this.runner = new RequestRunner(this.store, this.apis, this.environments, this.auth, this.config, this.history, redactor,
      message => process.stderr.write(`${terminalSafe(message)}\n`));
  }
  close(): void { this.store.close(); }
}

let current: AppContext | undefined;
export function context(command: Command): AppContext {
  current ??= new AppContext(command.optsWithGlobals().configDir as string | undefined);
  return current;
}
export function closeContext(): void { current?.close(); current = undefined; }
