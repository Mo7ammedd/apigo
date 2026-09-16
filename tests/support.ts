import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { AppContext } from '../src/cli/context.js';
import { Redactor } from '../src/utils/security.js';

export async function testContext(): Promise<{ app: AppContext; directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'apigo-test-'));
  const app = new AppContext(directory, new Redactor());
  return { app, directory, cleanup: async () => { app.close(); await rm(directory, { recursive: true, force: true }); } };
}

export async function cli(directory: string, args: string[], env: Record<string, string> = {}, stdin?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('src/index.ts'), ...args], {
      env: { ...process.env, APIGO_HOME: directory, NO_COLOR: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolveResult({ stdout, stderr, code: code ?? 1 }));
    child.stdin.end(stdin);
  });
}
