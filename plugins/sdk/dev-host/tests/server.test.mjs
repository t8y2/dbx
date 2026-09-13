import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createMockHost } from "../server.mjs";
import { ConnectionStore, lifecyclePayload, validateRecord } from "../connections.mjs";
import { readAsset } from "../assets.mjs";
import { Diagnostics } from "../diagnostics.mjs";

const manifest = {
  id: "example.echo",
  version: "1.0.0",
  name: "Generic echo",
  engines: { host_api: ">=1.0.0, <2.0.0" },
  permissions: ["host.events", "host.binary"],
  entrypoints: { backend: { transport: "stdio-framed", protocol_versions: [1] }, ui: { root: "ui", entry: "ui/index.html" } },
  contributions: [
    {
      type: "connection-provider",
      id: "example.connection",
      database_type: "example",
      label: "Example",
      workbench: "example.main",
      capabilities: ["test", "connect", "disconnect"],
      fields: [
        { key: "name", type: "text", binding: "name", required: true },
        { key: "endpoint", type: "text", binding: "config", required: true },
        { key: "count", type: "number", binding: "config" },
        { key: "enabled", type: "boolean", binding: "config" },
        { key: "password", type: "password", binding: "secret" },
      ],
    },
    { type: "workbench", id: "example.main", label: "Main" },
  ],
};
const values = { name: "Example connection", endpoint: "test-endpoint", count: 7, enabled: true, password: "test-password" };

test("radio fields accept only declared options", () => {
  const radioManifest = {
    ...manifest,
    contributions: manifest.contributions.map((contribution) =>
      contribution.id === "example.connection"
        ? {
            ...contribution,
            fields: [
              ...contribution.fields,
              {
                key: "protocol",
                type: "radio",
                binding: "config",
                default: "https",
                options: [
                  { label: "HTTPS", value: "https" },
                  { label: "HTTP", value: "http" },
                ],
              },
            ],
          }
        : contribution,
    ),
  };
  const valid = validateRecord(radioManifest, { providerId: "example.connection", values: { ...values, protocol: "http" } });
  assert.equal(valid.values.protocol, "http");
  assert.throws(() => validateRecord(radioManifest, { providerId: "example.connection", values: { ...values, protocol: "ftp" } }), /Invalid option: protocol/);
});
test("lifecycle failures do not report success or discard a live connection", async (t) => {
  const { host, request } = await fixture(t);
  const original = host.sidecar.request.bind(host.sidecar);
  let fail;
  host.sidecar.request = (method, ...args) => (method === fail ? Promise.resolve({ success: false, message: "Expected failure" }) : original(method, ...args));
  fail = "connection/test";
  assert.equal((await request("connections/test", { providerId: "example.connection", values })).status, 400);
  const saved = (await request("connections/save", { providerId: "example.connection", values })).value;
  fail = "connection/connect";
  assert.equal((await request("connections/connect", { id: saved.id })).status, 400);
  const snapshot = async () => (await (await fetch(`${host.origin}/api/bootstrap`)).json()).connections;
  assert.equal((await snapshot())[0].connected, false);
  fail = undefined;
  const frame = (await request("connections/connect", { id: saved.id })).value.frame;
  const document = (await request("frame-document", { frameId: frame.id })).value;
  fail = "custom/operation";
  const result = await request("bridge", { frameId: frame.id, channel: document.channel, method: "backend.invoke", params: { method: fail } });
  assert.equal(result.status, 200);
  assert.equal(result.value.success, false, "custom RPC results remain transparent");
  fail = "connection/disconnect";
  assert.equal((await request("frames/close", { id: frame.id })).status, 400);
  assert.equal((await snapshot())[0].connected, true);
  fail = undefined;
  assert.equal((await request("frames/close", { id: frame.id })).value.connections[0].connected, false);
});

test("page reconnects preserve frames, abandoned pages release their last connection", async (t) => {
  const { host, request, headers } = await fixture(t, false, { pageGraceMs: 150 });
  const page = { "X-DBX-Page": "browser-page" };
  const events = async () => {
    const response = await fetch(`${host.origin}/api/events?page=browser-page`, { headers });
    const reader = response.body.getReader();
    await reader.read();
    t.after(() => reader.cancel());
    return reader;
  };
  const first = await events();
  const saved = (await request("connections/save", { providerId: "example.connection", values }, page)).value;
  const opened = (await request("connections/connect", { id: saved.id }, page)).value.frame;
  await first.cancel();
  const second = await events();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await request("frame-document", { frameId: opened.id }, page)).status, 200);
  await second.cancel();
  let connected = true;
  for (let i = 0; i < 100 && connected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    connected = (await (await fetch(`${host.origin}/api/bootstrap`)).json()).connections[0].connected;
  }
  assert.equal(connected, false);
  assert.equal((await request("frame-document", { frameId: opened.id }, page)).status, 400);
  assert.equal(host.store.get(saved.id).values.name, values.name, "saved configuration survives page cleanup");
});
test("pages sharing a cookie have independent workbench generations", async (t) => {
  const { request } = await fixture(t, true);
  const a = { "X-DBX-Page": "page-a" },
    b = { "X-DBX-Page": "page-b" };
  const open = (headers) => request("workbenches/open", { contributionId: "example.main" }, headers);
  const first = (await open(a)).value.frame;
  const second = (await open(b)).value.frame;
  assert.notEqual(first.id, second.id);
  assert.equal((await open(a)).value.frame.id, first.id);
  const document = (await request("frame-document", { frameId: first.id }, a)).value;
  await request("frame-document", { frameId: second.id }, b);
  assert.equal((await request("frame-document", { frameId: first.id }, b)).status, 400);
  const result = await request("bridge", { frameId: first.id, channel: document.channel, method: "host.getContext" }, a);
  assert.equal(result.status, 200, JSON.stringify(result));
});

test("compiled UI output waits for a successful build signal", async (t) => {
  const { host, root } = await fixture(t, true, { uiBuildSignals: true });
  const revision = async () => (await (await fetch(`${host.origin}/api/bootstrap`)).json()).revision;
  await writeFile(join(root, "ui/index.html"), "<head></head>Partial output");
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(await revision(), 0);
  await host.uiBuilt();
  assert.equal(await revision(), 1);
});
test("refresh cleanup does not disconnect a connection still used by another page", async (t) => {
  const { host, request, headers } = await fixture(t, false, { pageGraceMs: 50 });
  const response = await fetch(`${host.origin}/api/events?page=old`, { headers });
  const reader = response.body.getReader();
  t.after(() => reader.cancel());
  await reader.read();
  const saved = (await request("connections/save", { providerId: "example.connection", values })).value;
  const old = (await request("connections/connect", { id: saved.id }, { "X-DBX-Page": "old" })).value.frame;
  const fresh = (await request("connections/connect", { id: saved.id }, { "X-DBX-Page": "fresh" })).value.frame;
  await reader.cancel();
  let status = 200;
  for (let i = 0; i < 100 && status === 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    status = (await request("frame-document", { frameId: old.id }, { "X-DBX-Page": "old" })).status;
  }
  assert.equal(status, 400);
  const bootstrap = await (await fetch(`${host.origin}/api/bootstrap`)).json();
  assert.equal(bootstrap.connections[0].connected, true);
  assert.deepEqual(bootstrap.manifest, manifest);
  assert.equal(Object.hasOwn(bootstrap, "rawManifest"), false);
  const closed = await request("frames/close", { id: fresh.id }, { "X-DBX-Page": "fresh" });
  assert.equal(closed.value.connections[0].connected, false);
});
async function fixture(t, frontend = false, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "dbx-mock-test-"));
  await mkdir(join(root, "ui"));
  await writeFile(join(root, "ui/index.html"), "<html><head></head><body>Test</body></html>");
  const actual = frontend ? { ...manifest, entrypoints: { ui: manifest.entrypoints.ui }, contributions: manifest.contributions.filter((c) => c.type === "workbench") } : manifest;
  await writeFile(join(root, "manifest.json"), JSON.stringify(actual));
  const host = await createMockHost({
    project: root,
    uiRoot: "ui",
    backend: process.execPath,
    diagnostics: new Diagnostics(() => {}),
    backendArgs: [fileURLToPath(new URL("./echo-sidecar.mjs", import.meta.url))],
    dataDir: join(root, "data"),
    shellHtml: join(root, "ui/index.html"),
    port: 0,
    backendWatch: root,
    buildBackend: async () => {
      throw new Error("Intentional build failure");
    },
    ...overrides,
  });
  t.after(async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  });
  const response = await fetch(`${host.origin}/api/bootstrap`),
    bootstrap = await response.json();
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const headers = { Cookie: cookie, Origin: host.origin, "X-Mock-Csrf": bootstrap.csrf, "Content-Type": "application/json" };
  const request = async (path, data = {}, overrides = {}) => {
    const response = await fetch(`${host.origin}/api/${path}`, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(data) });
    return { status: response.status, ...(await response.json()) };
  };
  return { root, host, request, headers };
}
test("hosts on different ports keep independent browser cookies", async (t) => {
  const first = await fixture(t, true),
    second = await fixture(t, true);
  const jar = new Map();
  const sessions = [];
  for (const host of [first.host, second.host]) {
    const response = await fetch(`${host.origin}/api/bootstrap`, { headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    const [key, value] = response.headers.get("set-cookie").split(";")[0].split("=");
    jar.set(key, value);
    sessions.push(await response.json());
  }
  for (const [index, host] of [first.host, second.host].entries()) {
    const response = await fetch(`${host.origin}/api/workbenches/open`, {
      method: "POST",
      headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), Origin: host.origin, "X-Mock-Csrf": sessions[index].csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ contributionId: "example.main" }),
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
});
test("diagnostics distinguish session failures and exclude connection credentials", async (t) => {
  const { host, request } = await fixture(t);
  const saved = await request("connections/save", { providerId: "example.connection", values });
  await request("connections/connect", { id: saved.value.id });
  const denied = await request("connections/save", { providerId: "example.connection", values }, { "X-Mock-Csrf": "secret-token" });
  assert.equal(denied.status, 403);
  const entries = host.diagnostics.snapshot();
  assert.ok(entries.some((e) => e.details.reason === "csrf-mismatch" && e.details.status === 403));
  assert.ok(entries.some((e) => e.details.method === "plugin/initialize" && e.message === "RPC 完成"));
  assert.ok(entries.some((e) => e.details.method === "connections/save" && e.details.status === 200));
  const text = JSON.stringify(entries);
  for (const secret of ["test-password", "secret-token"]) assert.equal(text.includes(secret), false);
  assert.ok(text.includes("test-endpoint"));
  assert.ok(entries.some((e) => e.details.port === Number(new URL(host.origin).port)));
  const response = await fetch(`${host.origin}/api/bootstrap`);
  assert.deepEqual((await response.json()).diagnostics, entries);
});
test("source watching is opt-in and automatic restarts preserve saved connections", async (t) => {
  let builds = 0;
  const { root, host, request } = await fixture(t, false, {
    buildBackend: async () => {
      builds++;
    },
  });
  const saved = await request("connections/save", { providerId: "example.connection", values });
  await writeFile(join(root, "example.rs"), "// disabled");
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(builds, 0);
  assert.equal((await request("auto-reload", { enabled: true })).value.enabled, true);
  await writeFile(join(root, "example.rs"), "// enabled");
  for (let i = 0; i < 100 && !host.diagnostics.snapshot().some((e) => e.message === "后端重建完成"); i++) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(builds, 1);
  assert.equal(host.sidecar.state, "ready");
  assert.equal(host.store.get(saved.value.id).values.name, values.name);
  await request("auto-reload", { enabled: false });
  await writeFile(join(root, "example.rs"), "// disabled again");
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(builds, 1);
});
test("agent diagnostics is read-only, bounded and does not log its own polling", async (t) => {
  const { host } = await fixture(t, true);
  const url = `${host.origin}/api/diagnostics`,
    headers = {};
  const first = await (await fetch(url, { headers })).json();
  assert.ok(first.entries.length);
  assert.equal(first.plugin.id, manifest.id);
  const next = await (await fetch(`${url}?after=${first.nextAfter}`, { headers })).json();
  assert.deepEqual(next.entries, []);
  assert.equal(next.nextAfter, first.nextAfter);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url, { headers, method: "POST" })).status, 405);
  assert.equal((await fetch(url, { headers: { ...headers, Origin: "https://other.test" } })).status, 403);
  assert.equal((await fetch(`${url}?limit=501`, { headers })).status, 400);
});
test("configuration mapping preserves typed external config and separates secrets", () => {
  const record = validateRecord(manifest, { providerId: "example.connection", values });
  const c = lifecyclePayload(manifest, record).connection;
  assert.deepEqual(c.external_config, { endpoint: "test-endpoint", count: 7, enabled: true });
  assert.deepEqual(c.connection_secrets, { password: "test-password" });
  assert.throws(() => validateRecord(manifest, { providerId: record.providerId, values: { ...values, count: "7" } }), /type/);
  assert.throws(() => validateRecord(manifest, { providerId: record.providerId, values: { ...values, endpoint: "" } }), /Missing/);
});

test("a frontend-only workbench opens without a connection or sidecar", async (t) => {
  const { host, request } = await fixture(t, true);
  assert.equal(host.sidecar.state, "frontend");
  assert.equal(host.sidecar.child, undefined);
  const opened = await request("workbenches/open", { contributionId: "example.main" });
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.value.frame.context, {});
  assert.equal((await request("workbenches/open", { contributionId: "example.main" })).value.frame.id, opened.value.frame.id);
  const f = (await request("frame-document", { frameId: opened.value.frame.id })).value;
  const rpc = await request("bridge", { frameId: f.id, channel: f.channel, method: "backend.invoke", params: { method: "echo" } });
  assert.equal(rpc.status, 400);
  assert.match(rpc.error.message, /no backend/);
  assert.equal((await request("frames/close", { id: f.id })).status, 200);
});
test("srcdoc workbench documents inline local Vite scripts and styles", async (t) => {
  const { root, request } = await fixture(t, true);
  await mkdir(join(root, "ui/assets"));
  await writeFile(join(root, "ui/assets/app.js"), "document.body.dataset.loaded = 'yes';");
  await writeFile(join(root, "ui/assets/app.css"), "body { color: red; }");
  await writeFile(join(root, "ui/index.html"), '<html><head><link rel="stylesheet" href="/assets/app.css"></head><body><script type="module" src="/assets/app.js"></script></body></html>');
  const opened = await request("workbenches/open", { contributionId: "example.main" });
  const document = (await request("frame-document", { frameId: opened.value.frame.id })).value;
  assert.match(document.html, /document\.body\.dataset\.loaded/);
  assert.match(document.html, /body \{ color: red; \}/);
  assert.doesNotMatch(document.html, /src="\/assets\/app\.js"/);
  assert.doesNotMatch(document.html, /href="\/assets\/app\.css"/);
});
test("save, reload, iframe isolation, generic RPC and close lifecycle", async (t) => {
  const { root, host, request } = await fixture(t);
  const saved = await request("connections/save", { providerId: "example.connection", values });
  assert.equal(saved.status, 200);
  const id = saved.value.id;
  assert.equal(JSON.stringify(saved).includes("test-password"), false);
  const stored = new ConnectionStore(join(root, "data"), manifest);
  await stored.load();
  assert.deepEqual(stored.get(id).values, values);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(root, "data"))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, "data/connections.json"))).mode & 0o777, 0o600);
  }
  const opened = await request("connections/connect", { id });
  const f = opened.value.frame;
  assert.equal((await request("connections/connect", { id })).value.frame.id, f.id);
  assert.deepEqual(f.context, { connectionId: id, providerId: "example.connection", connectionType: "example" });
  assert.equal(JSON.stringify(f).includes("test-password"), false);
  const document = (await request("frame-document", { frameId: f.id })).value;
  assert.match(document.html, /Content-Security-Policy/);
  assert.match(document.html, /window.dbxPlugin/);
  const call = (method, params) => request("bridge", { frameId: f.id, channel: document.channel, method, params });
  assert.deepEqual((await call("backend.invoke", { method: "echo", params: { anyBusiness: 123 } })).value, { anyBusiness: 123 });
  assert.equal((await call("host.openWorkbench", { contributionId: "example.main" })).status, 400);
  assert.equal((await call("host.openFilesystem", {})).status, 400);
  assert.equal((await call("backend.invoke", { method: "echo", params: "x".repeat(2 * 1024 * 1024) })).status, 400);
  assert.equal((await request("bridge", { frameId: f.id, channel: "old", method: "host.getContext" })).status, 400);
  await request("connections/save", { id, providerId: "example.connection", values: { ...values, name: "Renamed connection" } });
  const renamed = (await request("connections/connect", { id })).value.frame;
  assert.equal(renamed.id, f.id);
  assert.equal(renamed.name, "Renamed connection");
  assert.equal((await request("frames/close", { id: f.id })).value.connections[0].connected, false);
  const failedBuild = await request("backend/restart");
  assert.equal(failedBuild.status, 400);
  assert.equal(host.sidecar.state, "stopped");
});
test("loopback endpoint rejects cross-origin, forged Host, CSRF and unowned frames", async (t) => {
  const { host, request, headers } = await fixture(t);
  assert.equal((await request("connections/save", {}, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await request("connections/save", {}, { "X-Mock-Csrf": "wrong" })).status, 403);
  const bad = await new Promise((resolve, reject) => {
    const request = http.get(`${host.origin}/api/bootstrap`, { headers: { Host: "evil.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
  });
  assert.equal(bad, 403);
  const saved = await request("connections/save", { providerId: "example.connection", values });
  const f = (await request("connections/connect", { id: saved.value.id })).value.frame;
  const other = await fetch(`${host.origin}/api/bootstrap`);
  const boot = await other.json();
  assert.equal((await request("frame-document", { frameId: f.id }, { ...headers, Cookie: other.headers.get("set-cookie").split(";")[0], "X-Mock-Csrf": boot.csrf })).status, 400);
});
test("asset reader rejects traversal and symlinks outside the UI root", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "secret"), "test-secret");
  await symlink(join(root, "secret"), join(root, "ui/link"));
  await assert.rejects(readAsset(join(root, "ui"), "../secret"), /outside/);
  await assert.rejects(readAsset(join(root, "ui"), "link"), /outside/);
  assert.equal(Buffer.from((await readAsset(join(root, "ui"), "index.html")).dataBase64, "base64").toString(), await readFile(join(root, "ui/index.html"), "utf8"));
});

test("UI root overrides and port collision fallback work without changing the plugin manifest", async (t) => {
  const { root, host } = await fixture(t);
  await mkdir(join(root, "alternate-ui"));
  await writeFile(join(root, "alternate-ui/index.html"), "<html>Alternate output</html>");
  const second = await createMockHost({
    project: root,
    uiRoot: "alternate-ui",
    backend: process.execPath,
    backendArgs: [fileURLToPath(new URL("./echo-sidecar.mjs", import.meta.url))],
    dataDir: join(root, "second-data"),
    shellHtml: join(root, "alternate-ui/index.html"),
    port: Number(new URL(host.origin).port),
  });
  try {
    assert.notEqual(second.origin, host.origin);
    assert.equal((await fetch(second.origin)).status, 200);
  } finally {
    await second.close();
  }
  await writeFile(join(root, "manifest.json"), JSON.stringify({ ...manifest, engines: { host_api: ">=2.0.0" } }));
  await assert.rejects(createMockHost({ project: root }), /does not support Host API/);
});
