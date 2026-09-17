import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'apigo-package-'));
const installed = join(temporary, 'installed');
const linked = join(temporary, 'linked');
const state = join(temporary, 'state');
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run the smoke test through npm run test:package, or set npm_execpath to npm-cli.js.');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? project, env: { ...process.env, APIGO_HOME: state, NO_COLOR: '1', ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Package verification command failed (${code}): ${args.join(' ')}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}
const npm = (args, options) => run(process.execPath, [npmCli, ...args], options);
let server;

try {
  const packed = await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temporary]);
  const packResult = JSON.parse(packed.stdout);
  // npm 12 keys pack results by package name; npm 10/11 return an array.
  const manifest = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  assert(manifest?.filename, 'npm pack did not return an archive manifest.');
  const archive = join(temporary, manifest.filename);
  const shipped = manifest.files.map(file => file.path);
  assert(shipped.includes('dist/index.js'));
  assert(shipped.includes('README.md'));
  assert(shipped.includes('LICENSE'));
  assert(!shipped.some(path => path.startsWith('tests/') || path.includes('secret.key') || path.endsWith('.db')));
  await mkdir(installed);
  // Exercise a real native dependency install, including npm 12's script policy.
  await writeFile(join(installed, 'package.json'), JSON.stringify({ private: true, allowScripts: { 'better-sqlite3': true } }));
  await npm(['install', '--prefix', installed, '--no-audit', '--no-fund', archive]);
  const packageRoot = join(installed, 'node_modules', manifest.name);
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.apigo, './dist/index.js');
  const entry = join(packageRoot, 'dist', 'index.js');
  assert((await readFile(entry, 'utf8')).startsWith('#!/usr/bin/env node\n'));
  const cli = args => run(process.execPath, [entry, ...args]);
  assert.equal((await cli(['--version'])).stdout.trim(), pkg.version);
  assert((await cli(['--help'])).stdout.includes('openapi'));

  const specification = JSON.parse(await readFile(join(project, 'tests', 'fixtures', 'aspnet-openapi.json'), 'utf8'));
  server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(request.url === '/swagger/v1/swagger.json' ? JSON.stringify(specification) : JSON.stringify({ id: 42, vin: '1HGCM82633A004352' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  specification.servers = [{ url: base }];
  const imported = await cli(['openapi', `${base}/swagger/v1/swagger.json`, '--name', 'smoke', '--json']);
  assert.equal(imported.stderr, '');
  assert.equal(JSON.parse(imported.stdout).endpoints, 7);
  const response = await cli(['run', 'vehicles.get', '--id', '42', '--no-auth', '--json']);
  assert.equal(response.stderr, '');
  assert.equal(JSON.parse(response.stdout).id, 42);
  await cli(['save', 'installed-request']);
  assert.equal(JSON.parse((await cli(['run', 'installed-request', '--json'])).stdout).id, 42);

  const npxCli = join(dirname(npmCli), 'npx-cli.js');
  await access(npxCli);
  const npx = await run(process.execPath, [npxCli, '--offline', '--prefix', installed, 'apigo', '--version'], { cwd: installed });
  assert.equal(npx.stdout.trim(), pkg.version);

  await npm(['link', '--ignore-scripts', '--no-audit', '--no-fund'], { env: { npm_config_prefix: linked } });
  const linkEntry = process.platform === 'win32' ? join(linked, 'node_modules', pkg.name, 'dist', 'index.js') : join(linked, 'lib', 'node_modules', pkg.name, 'dist', 'index.js');
  assert.equal((await run(process.execPath, [linkEntry, '--version'])).stdout.trim(), pkg.version);
  if (process.platform !== 'win32') assert.equal((await run(join(linked, 'bin', 'apigo'), ['--version'])).stdout.trim(), pkg.version);
  console.log(`Package verified: ${pkg.name}@${pkg.version}; tarball install, executable, SQLite import/run, saved replay, npx, and npm link.`);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
