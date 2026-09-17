import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
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
      if (code !== (options.expectedCode ?? 0)) reject(new Error(`Package verification command failed (${code}): ${args.join(' ')}\n${stderr}`));
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
  // Exercise an install with native scripts skipped, then the supported rebuild.
  await writeFile(join(installed, 'package.json'), JSON.stringify({ private: true, allowScripts: { 'better-sqlite3': true } }));
  await npm(['install', '--prefix', installed, '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  const packageRoot = join(installed, 'node_modules', manifest.name);
  const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.apigo, './dist/index.js');
  const entry = join(packageRoot, 'dist', 'index.js');
  assert((await readFile(entry, 'utf8')).startsWith('#!/usr/bin/env node\n'));
  const cli = (args, options) => run(process.execPath, [entry, ...args], options);
  assert.equal((await cli(['--version'])).stdout.trim(), pkg.version);
  assert((await cli(['--help'])).stdout.includes('openapi'));
  const missingNative = await cli(['config', 'list', '--json'], { expectedCode: 2 });
  assert.equal(missingNative.stdout, '');
  assert(missingNative.stderr.includes('SQLITE_UNAVAILABLE'));
  assert(missingNative.stderr.includes('--allow-scripts=better-sqlite3'));
  assert(!missingNative.stderr.includes('permissions'));
  const sqlitePackage = dirname(createRequire(entry).resolve('better-sqlite3/package.json'));
  const nativeBinary = join(sqlitePackage, 'build', 'Release', 'better_sqlite3.node');
  await mkdir(dirname(nativeBinary), { recursive: true });
  await writeFile(nativeBinary, 'not a native module');
  try {
    const incompatibleNative = await cli(['config', 'list', '--json'], { expectedCode: 2 });
    assert.equal(incompatibleNative.stdout, '');
    assert(incompatibleNative.stderr.includes('SQLITE_UNAVAILABLE'));
    assert(incompatibleNative.stderr.includes('--allow-scripts=better-sqlite3'));
  } finally { await rm(nativeBinary); }
  await npm(['rebuild', '--prefix', installed, 'better-sqlite3', '--no-audit', '--no-fund']);

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

  const globalPrefix = join(temporary, 'global');
  await npm(['install', '--global', '--prefix', globalPrefix, '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  const globalEntry = process.platform === 'win32' ? join(globalPrefix, 'node_modules', pkg.name, 'dist', 'index.js') : join(globalPrefix, 'lib', 'node_modules', pkg.name, 'dist', 'index.js');
  const missingGlobalNative = await run(process.execPath, [globalEntry, 'config', 'list', '--json'], { expectedCode: 2 });
  assert(missingGlobalNative.stderr.includes('SQLITE_UNAVAILABLE'));
  await npm(['rebuild', '--global', '--prefix', globalPrefix, 'better-sqlite3', '--allow-scripts=better-sqlite3', '--no-audit', '--no-fund']);
  const globalConfig = await run(process.execPath, [globalEntry, 'config', 'list', '--json']);
  JSON.parse(globalConfig.stdout);

  await npm(['link', '--ignore-scripts', '--no-audit', '--no-fund'], { env: { npm_config_prefix: linked } });
  const linkEntry = process.platform === 'win32' ? join(linked, 'node_modules', pkg.name, 'dist', 'index.js') : join(linked, 'lib', 'node_modules', pkg.name, 'dist', 'index.js');
  assert.equal((await run(process.execPath, [linkEntry, '--version'])).stdout.trim(), pkg.version);
  if (process.platform !== 'win32') assert.equal((await run(join(linked, 'bin', 'apigo'), ['--version'])).stdout.trim(), pkg.version);
  console.log(`Package verified: ${pkg.name}@${pkg.version}; native module diagnostics, project/global rebuilds, tarball install, executable, SQLite import/run, saved replay, npx, and npm link.`);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
