import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('dev selects the bundled runtime and current Node without changing ordinary launcher behavior', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dbx-dev-launcher-'));
  try {
    writeFileSync(join(cwd, 'dev'), 'console.log(JSON.stringify({runtime:process.env.DBX_PLUGIN_DEV_RUNTIME,node:process.env.DBX_PLUGIN_NODE,args:process.argv.slice(2)}))');
    const invoke = extra => spawnSync(process.execPath, [join(root, 'bin/dbx-plugin.js'), 'dev', '--port', '5190'], {
      cwd, encoding: 'utf8', env: { ...process.env, DBX_PLUGIN_CLI_BINARY: process.execPath, DBX_PLUGIN_NODE: '', DBX_PLUGIN_DEV_RUNTIME: '', ...extra },
    });
    const result = invoke({}); assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout); assert.equal(data.runtime, join(root, 'dev-runtime/runtime.mjs')); assert.equal(data.node, process.execPath); assert.deepEqual(data.args, ['--port','5190']);
    const explicit = invoke({ DBX_PLUGIN_DEV_RUNTIME: '/custom/runtime.mjs', DBX_PLUGIN_NODE: '/custom/node' });
    assert.equal(JSON.parse(explicit.stdout).runtime, '/custom/runtime.mjs');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
