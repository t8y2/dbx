import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(packageRoot, '../../plugins/sdk/dev-host');
const destination = resolve(packageRoot, 'dev-runtime');
if (process.argv.includes('--clean')) {
  rmSync(destination, { recursive: true, force: true });
} else {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Building dev runtime requires Node.js 22+');
  if (!existsSync(resolve(root, 'node_modules/vite'))) throw new Error('Run npm ci --prefix plugins/sdk/dev-host before packing the CLI');
  const result = spawnSync(process.execPath, [resolve(root, 'build.mjs')], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Development runtime build failed');
  rmSync(destination, { recursive: true, force: true });
  cpSync(resolve(root, 'dist'), destination, { recursive: true });
}
