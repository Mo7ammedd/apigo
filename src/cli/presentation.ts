import type { Command } from 'commander';
import ora from 'ora';
import type { AppContext } from './context.js';
import { options } from './options.js';
import { terminalSafe } from '../utils/security.js';

export function present(command: Command, app: AppContext, data: unknown, human: () => string, metadata = false): void {
  const raw = options(command);
  if (raw.json) process.stdout.write(`${JSON.stringify(raw.showSensitive ? data : metadata ? app.redactor.metadata(data) : app.redactor.clean(data), null, 2)}\n`);
  else process.stdout.write(terminalSafe(raw.showSensitive ? human() : app.redactor.text(human())));
}

export async function loading<T>(command: Command, message: string, action: () => Promise<T>): Promise<T> {
  if (!process.stderr.isTTY || options(command).json) return action();
  const spinner = ora({ text: message, color: 'white', stream: process.stderr }).start();
  try { return await action(); } finally { spinner.stop(); }
}
