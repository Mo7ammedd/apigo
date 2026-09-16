import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface StoragePaths { directory: string; database: string; key: string }

export function storagePaths(override?: string): StoragePaths {
  let directory: string;
  if (override || process.env.APIGO_HOME) directory = resolve(override ?? process.env.APIGO_HOME!);
  else if (process.platform === 'win32') directory = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'apigo');
  else if (process.platform === 'darwin') directory = join(homedir(), 'Library', 'Application Support', 'apigo');
  else directory = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'apigo');
  return { directory, database: join(directory, 'apigo.db'), key: join(directory, 'secret.key') };
}
