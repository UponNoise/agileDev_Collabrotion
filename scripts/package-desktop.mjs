import { packager } from '@electron/packager';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This packaging path currently verifies Windows x64 only.');
if (!process.env.npm_execpath) throw new Error('Run npm run package:desktop so the trusted npm CLI is explicit.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stage = mkdtempSync(join(tmpdir(), 'agiledev-package-'));
const app = join(stage, 'app');
const service = join(stage, 'service');
const compiled = join(stage, 'dist');
for (const args of [
  [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', compiled],
  [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', join(root, 'vite.config.ts'), '--outDir', join(compiled, 'web')]
]) execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
mkdirSync(join(app, 'dist'), { recursive: true });
mkdirSync(join(service, 'runtime'), { recursive: true });
for (const file of ['desktop.js', 'desktop-policy.js', 'desktop-attention.js', 'desktop-attention-runtime.js', 'service-launcher.js']) cpSync(join(compiled, file), join(app, 'dist', file));
cpSync(join(root, 'src', 'desktop-preload.cjs'), join(app, 'dist', 'desktop-preload.cjs'));
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'agiledev-collaboration', productName: 'AgileDev Collaboration', author: 'AgileDev contributors', version: manifest.version, type: 'module', main: 'dist/desktop.js', private: true }, null, 2));
for (const file of ['package.json', 'package-lock.json']) cpSync(join(root, file), join(service, file));
cpSync(compiled, join(service, 'dist'), { recursive: true });
for (const args of [['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], ['rebuild', 'better-sqlite3']]) execFileSync(process.execPath, [process.env.npm_execpath, ...args, '--cache', join(stage, 'npm-cache')], { cwd: service, stdio: 'inherit', windowsHide: true });
const archiveName = `node-${process.version}-win-x64.zip`;
const base = `https://nodejs.org/dist/${process.version}`;
async function download(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Official runtime download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}
const sums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8');
const expected = sums.split(/\r?\n/).find(line => line.endsWith(`  ${archiveName}`))?.split(' ')[0];
if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('Official runtime checksum was not found.');
const archive = await download(`${base}/${archiveName}`);
if (createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('Official runtime checksum did not match.');
const zip = join(stage, archiveName);
const extracted = join(stage, 'node');
writeFileSync(zip, archive);
const quote = value => `'${value.replaceAll("'", "''")}'`;
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(extracted)}`], { windowsHide: true, stdio: 'inherit' });
const nodeRoot = join(extracted, `node-${process.version}-win-x64`);
for (const file of ['node.exe', 'LICENSE']) cpSync(join(nodeRoot, file), join(service, 'runtime', file));
const runtime = join(service, 'runtime', 'node.exe');
const actualVersion = execFileSync(runtime, ['-p', 'process.version'], { encoding: 'utf8', windowsHide: true }).trim();
if (actualVersion !== process.version) throw new Error('Bundled runtime version does not match the native dependency build.');
execFileSync(runtime, ['--input-type=module', '-e', "import Database from 'better-sqlite3'; const db = new Database(':memory:'); if (db.prepare('select 1 as value').get().value !== 1) process.exit(1); db.close();"], { cwd: service, windowsHide: true, stdio: 'inherit' });
writeFileSync(join(service, 'runtime.json'), JSON.stringify({ node: process.version, archive: archiveName, sha256: expected, platform: process.platform, arch: process.arch }, null, 2));
mkdirSync(join(root, 'release'), { recursive: true });
const output = mkdtempSync(join(root, 'release', 'build-'));
const paths = await packager({ dir: app, name: 'AgileDev Collaboration', executableName: 'AgileDev', appVersion: manifest.version, electronVersion: manifest.devDependencies.electron, platform: 'win32', arch: 'x64', asar: true, extraResource: service, out: output, overwrite: false });
writeFileSync(join(root, 'release', 'latest.json'), JSON.stringify({ directory: paths[0], node: actualVersion, electron: manifest.devDependencies.electron, appArchiveSha256: createHash('sha256').update(readFileSync(join(paths[0], 'resources', 'app.asar'))).digest('hex') }, null, 2));
console.log(JSON.stringify({ packages: paths, stage, runtime: { version: actualVersion, sha256: expected } }, null, 2));
