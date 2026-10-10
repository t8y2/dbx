import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
assert(args.includes('--plugin-dir'), 'Pass --plugin-dir with the installed native plugin directory');
const pluginDir = await realpath(resolve(option('--plugin-dir')));
// Keep the disposable fixture for browser acceptance and inspection after the run.
const dataDir = await realpath(await mkdtemp(join(tmpdir(), 'dbx-codex-acceptance-')));
const clients = [];
function client() {
  const child = spawn(join(pluginDir, 'bin', process.platform === 'win32' ? 'dbx-codex.exe' : 'dbx-codex'), [], {
    cwd: pluginDir, env: { ...process.env, DBX_CODEX_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 0;
  const pending = new Map();
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-2000); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (!pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(timer);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  });
  child.on('error', (error) => { for (const item of pending.values()) item.reject(error); });
  child.on('exit', (code) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Gateway exited ${code}: ${diagnostics}`)); }
    pending.clear();
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const api = { child, request, notify, call: (name, arguments_ = {}) => request('tools/call', { name, arguments: arguments_ }) };
  clients.push(api);
  return api;
}
async function initialize(api) {
  await api.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dbx-native-acceptance', version: '1' } });
  api.notify('notifications/initialized', {});
}
let current;
let base;
let cookie;
let passed = false;
async function http(path, method = 'GET', body, authenticated = true) {
  const response = await fetch(new URL(path, base), { method, headers: {
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(authenticated && cookie ? { cookie } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.text();
  assert(response.ok, `${method} ${path}: ${response.status} ${value.slice(0, 500)}`);
  return { response, value: value ? JSON.parse(value) : null };
}
const structured = (result) => { assert(!result.isError, JSON.stringify(result)); return result.structuredContent; };
const password = 'DBX-native-acceptance-only-42!';
try {
  current = client();
  await initialize(current);
  const first = structured(await current.call('dbx_codex_open'));
  base = first.workbench_url ?? first.url;
  assert(base, JSON.stringify(first));
  assert.equal(structured(await current.call('dbx_codex_status')).database_ready, false);
  const initialTools = await current.request('tools/list');
  assert.deepEqual(initialTools.tools.map((tool) => tool.name).sort(), ['dbx_codex_open', 'dbx_codex_status', 'dbx_codex_stop']);
  const html = await (await fetch(base)).text();
  assert.match(html, /<html/);
  const asset = html.match(/(?:src|href)="([^" ]+\.js)"/);
  assert(asset, 'Embedded application script missing');
  const script = await fetch(new URL(asset[1], base));
  assert(script.ok && (await script.text()).length > 1000, 'Embedded JS missing');
  const setup = await http('/api/auth/setup', 'POST', { password });
  cookie = setup.response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'Setup must return a session cookie');
  await http('/api/migration/start', 'POST');
  const sqlitePath = join(dataDir, 'acceptance.sqlite');
  const fixture = new DatabaseSync(sqlitePath);
  const longCell = '中文原始数据'.repeat(1000);
  fixture.exec('CREATE TABLE samples(id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0)');
  const insert = fixture.prepare('INSERT INTO samples VALUES(?, ?)');
  for (let i = 1; i <= 150; i++) insert.run(i, longCell);
  const config = { id: 'codex-smoke', name: 'Codex acceptance SQLite', db_type: 'sqlite', host: sqlitePath, port: 0, username: '', password: '', database: null, ssl: false };
  const savedSecret = { ...config, id: 'secret-persistence', name: 'Unconnected credential fixture', db_type: 'postgres', host: '127.0.0.1', port: 1, password: 'synthetic-credential-only' };
  await http('/api/connection/save', 'POST', { configs: [config, savedSecret], removedIds: [] });
  await http('/api/connection/connect', 'POST', { config });
  const policy = (readOnly) => ({ readOnly, allowDangerousSql: false, promptHighRiskSql: false, allowedConnectionIds: null });
  await http('/api/app-settings/mcp-policy', 'PUT', policy(true));
  const second = client();
  await initialize(second);
  assert.equal(structured(await second.call('dbx_codex_open')).instance_id, first.instance_id);
  current.child.stdin.end();
  current = second;
  assert.equal(structured(await current.call('dbx_codex_status')).database_ready, true);
  const tools = await current.request('tools/list');
  assert(tools.tools.some((tool) => tool.name === 'dbx_codex_execute_and_show'));
  const selector = { connection_id: config.id, database: 'main' };
  const result = structured(await current.call('dbx_codex_execute_and_show', { ...selector, sql: 'SELECT * FROM samples; SELECT value FROM counter' }));
  assert.equal(result.results.length, 2);
  assert(JSON.stringify(result.results).includes(longCell), 'Original long cell must not be truncated');
  const intentPath = `/api/codex/intents/${new URL(result.workbench_url).searchParams.get('codex_intent')}`;
  assert.equal((await fetch(new URL(intentPath, base))).status, 401);
  const intent = (await http(intentPath)).value;
  assert.deepEqual(intent.results, result.results);
  assert.deepEqual((await http(intentPath)).value, intent);
  const denied = await current.call('dbx_codex_execute_and_show', { ...selector, sql: 'UPDATE counter SET value = value + 1 WHERE value = 0' });
  assert(denied.isError || JSON.stringify(denied).includes('READ_ONLY'), 'Read-only write must fail');
  assert.equal(fixture.prepare('SELECT value FROM counter').get().value, 0);
  await http('/api/app-settings/mcp-policy', 'PUT', policy(false));
  const write = structured(await current.call('dbx_codex_execute_and_show', { ...selector, sql: 'UPDATE counter SET value = value + 1 WHERE value = 0' }));
  assert.equal(fixture.prepare('SELECT value FROM counter').get().value, 1);
  const writePath = `/api/codex/intents/${new URL(write.workbench_url).searchParams.get('codex_intent')}`;
  await http(writePath); await http(writePath);
  assert.equal(fixture.prepare('SELECT value FROM counter').get().value, 1);
  const table = await current.call('dbx_codex_open_table', { ...selector, table: 'samples' });
  assert(!table.isError, JSON.stringify(table));
  await current.request('resources/list');
  const secret = await readFile(join(dataDir, '.dbx', 'secret.key'));
  assert.equal((await current.call('dbx_codex_stop')).isError, true);
  structured(await current.call('dbx_codex_stop', { confirm_interrupt: true }));
  current.child.stdin.end();
  const shutdownDeadline = Date.now() + 20000;
  while (await readFile(join(dataDir, 'runtime.json')).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) {
    assert(Date.now() < shutdownDeadline, 'Service did not finish graceful shutdown');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  current = client(); await initialize(current);
  const restarted = structured(await current.call('dbx_codex_open'));
  assert.notEqual(restarted.instance_id, first.instance_id);
  base = restarted.workbench_url ?? restarted.url;
  cookie = undefined;
  const login = await http('/api/auth/login', 'POST', { password });
  cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  assert.deepEqual(await readFile(join(dataDir, '.dbx', 'secret.key')), secret);
  assert(JSON.stringify((await http('/api/connection/list')).value).includes(config.id));
  assert.equal(fixture.prepare('SELECT value FROM counter').get().value, 1);
  fixture.close();
  await http('/api/connection/connect', 'POST', { config });
  const reopened = structured(await current.call('dbx_codex_execute_and_show', { ...selector, sql: 'SELECT id, length(body) AS original_length FROM samples LIMIT 3; SELECT value FROM counter' }));
  assert.equal(reopened.results.length, 2);
  passed = true;
  console.log(JSON.stringify({ passed: true, pluginDir, dataDir, workbenchUrl: base, resultUrl: reopened.workbench_url, checks: ['native stdio', 'embedded assets', 'setup gate', 'shared lifetime', 'SQLite', 'raw result intent', 'read-only policy', 'write exactly once', 'explicit stop', 'restart persistence'] }, null, 2));
} finally {
  if (current && current.child.exitCode === null && !(passed && args.includes('--keep-running'))) {
    try { await current.call('dbx_codex_stop', { confirm_interrupt: true }); } catch { /* Startup failures have no service to stop. */ }
  }
  for (const api of clients) api.child.stdin.end();
}
