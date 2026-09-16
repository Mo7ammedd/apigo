import { chmodSync, readFileSync } from 'node:fs';

const entry = new URL('../dist/index.js', import.meta.url);
if (!readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node\n')) {
  throw new Error('The CLI bundle is missing its executable shebang.');
}
chmodSync(entry, 0o755);
