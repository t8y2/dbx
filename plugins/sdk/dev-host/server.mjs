import http from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { readFile, realpath, watch } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import semver from "semver";
import { Sidecar, protocolName } from "./sidecar.mjs";
import { ConnectionStore, lifecyclePayload, providerFor, summary, validateRecord } from "./connections.mjs";
import { readAsset } from "./assets.mjs";
import { sandboxDocument } from "./browser-bridge.mjs";
import { Diagnostics } from "./diagnostics.mjs";
import { AutoReload } from "./auto-reload.mjs";

const BRIDGE_LIMIT = 2 * 1024 * 1024,
  UI_BINARY_LIMIT = 8 * 1024 * 1024;
function jsonSize(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}
function requirePermission(manifest, permission) {
  if (!manifest.permissions?.includes(permission)) throw new Error(`Plugin permission required: ${permission}`);
}
function ensureSucceeded(result) {
  if (result?.success === false) throw new Error(result.message || "Plugin connection operation failed");
}
function pageId(value = "legacy") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(value)) throw new Error("Invalid page ID");
  return value;
}
function localDocumentAssetPath(url, entry) {
  if (typeof url !== "string" || /^(?:data|blob|https?):/i.test(url) || url.startsWith("//") || url.startsWith("#")) return undefined;
  try {
    const parsed = new URL(url, `http://dbx-plugin.local/${entry}`);
    if (parsed.origin !== "http://dbx-plugin.local") return undefined;
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    return path || undefined;
  } catch {
    return undefined;
  }
}

export async function createMockHost(options) {
  const diagnostics = options.diagnostics || new Diagnostics();
  const project = resolve(options.project),
    manifest = JSON.parse(await readFile(resolve(project, "manifest.json"), "utf8"));
  for (const contribution of manifest.contributions || [])
    for (const field of contribution.fields || []) {
      if (field.type === "password" || ["password", "secret"].includes(field.binding)) diagnostics.secretKeys.add(field.key);
    }
  if (manifest.manifest_version !== undefined && manifest.manifest_version !== 1) throw new Error("Unsupported manifest version");
  // DBX uses Rust semver requirements, whose comparator separators include commas.
  if (manifest.engines?.host_api && !semver.satisfies("1.0.0", manifest.engines.host_api.replaceAll(",", " "))) throw new Error("Plugin does not support Host API 1.0.0");
  const backendEntry = manifest.entrypoints?.backend;
  const transport = backendEntry?.transport || "stdio-jsonl";
  if (backendEntry && (!["stdio-framed", "stdio-jsonl"].includes(transport) || !(backendEntry.protocol_versions || [1]).includes(1))) throw new Error("Unsupported backend transport or protocol version");
  const declaredRoot = resolve(project, manifest.entrypoints.ui.root || "ui");
  const uiRoot = resolve(project, options.uiRoot || declaredRoot);
  const entry = relative(declaredRoot, resolve(project, manifest.entrypoints.ui.entry));
  await readAsset(uiRoot, entry);
  const store = new ConnectionStore(resolve(options.dataDir), manifest);
  await store.load();
  const dataRelative = relative(await realpath(uiRoot), await realpath(store.directory));
  if (!dataRelative || (!isAbsolute(dataRelative) && dataRelative !== ".." && !dataRelative.startsWith(`..${sep}`))) {
    throw new Error("Development data directory must be outside the UI resource root");
  }
  if (backendEntry && !options.backend) throw new Error("Backend executable is required");
  const sidecar = new Sidecar({ executable: backendEntry ? resolve(project, options.backend) : undefined, args: options.backendArgs || [], cwd: project, manifest, transport });
  const connected = new Set(),
    frames = new Map(),
    sessions = new Map(),
    streams = new Set();
  const pages = new Map();
  let revision = 0,
    restarting = false,
    closing = false,
    origin,
    cookieName;
  let lifecycleQueue = Promise.resolve();
  const serialize = (action) => {
    const task = lifecycleQueue.then(action);
    lifecycleQueue = task.catch(() => {});
    return task;
  };
  let autoReload = false;
  const backendReload = new AutoReload(async () => {
    try {
      await serialize(async () => {
        if (autoReload && !closing) await restartBackend();
      });
    } catch {
      broadcast("auto-reload-error", {});
    }
  });
  const broadcast = (type, payload) => {
    const message = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
    for (const stream of streams) {
      if (stream.writableLength > 16 * 1024 * 1024) {
        stream.destroy();
        streams.delete(stream);
      } else stream.write(message);
    }
  };
  const onDiagnostic = (entry) => broadcast("diagnostic", { entry });
  diagnostics.on("entry", onDiagnostic);
  sidecar.on("diagnostic", (event) => diagnostics.record(event.level, "rpc", event.message, event.details));
  sidecar.on("status", (state) => diagnostics.record(state === "failed" ? "error" : "info", "backend", "后端状态变化", { state, transport }));
  sidecar.on("event", () => diagnostics.record("debug", "event", "收到后端事件"));
  sidecar.on("binary", (event) => diagnostics.record("debug", "binary", "收到二进制帧", { bytes: Buffer.byteLength(event.dataBase64, "base64") }));
  sidecar.on("status", (state) => {
    if (state !== "ready") connected.clear();
    broadcast("status", { state });
  });
  sidecar.on("event", (event) => {
    if (manifest.permissions?.includes("host.events")) broadcast("event", event);
  });
  sidecar.on("binary", (event) => {
    if (manifest.permissions?.includes("host.binary") && event.dataBase64.length <= (UI_BINARY_LIMIT / 3) * 4 + 4) broadcast("binary", event);
  });
  try {
    await sidecar.start();
  } catch (error) {
    diagnostics.removeListener("entry", onDiagnostic);
    throw error;
  }

  const listing = () => store.records.map((r) => ({ ...summary(manifest, r), connected: connected.has(r.id) }));
  async function disconnect(id) {
    if (connected.has(id) && sidecar.state === "ready") {
      ensureSucceeded(await sidecar.request("connection/disconnect", lifecyclePayload(manifest, store.get(id)), 10000));
    }
    connected.delete(id);
  }
  async function connect(record) {
    if (restarting || sidecar.state !== "ready") throw new Error("Backend is not ready; restart it first");
    const provider = providerFor(manifest, record.providerId);
    if (!provider.capabilities?.includes("connect")) throw new Error("Provider does not support connect");
    validateRecord(manifest, record);
    if (!connected.has(record.id)) {
      ensureSucceeded(await sidecar.request("connection/connect", lifecyclePayload(manifest, record), 60000));
      connected.add(record.id);
    }
  }
  async function openFrame(session, connectionId, contributionId, suppliedContext) {
    const record = connectionId ? store.get(connectionId) : undefined;
    const provider = record ? providerFor(manifest, record.providerId) : undefined;
    const contribution = manifest.contributions.find((c) => c.id === (contributionId || provider?.workbench) && c.type === "workbench");
    if (!contribution) throw new Error("Unknown workbench contribution");
    if (record) await connect(record);
    const context = record ? { ...suppliedContext, connectionId: record.id, providerId: provider.id, connectionType: provider.database_type } : { ...suppliedContext };
    const name = record ? summary(manifest, record).name : contribution.label;
    if (jsonSize(context) > BRIDGE_LIMIT) throw new Error("Context exceeds limit");
    const existing = [...frames.values()].find((f) => f.session === session.id && f.page === session.page && f.connectionId === connectionId && f.contributionId === contribution.id);
    if (existing) {
      existing.context = context;
      existing.name = name;
      return expose(existing);
    }
    const frame = { id: randomUUID(), channel: randomUUID(), session: session.id, page: session.page, connectionId, contributionId: contribution.id, context, name };
    frames.set(frame.id, frame);
    return expose(frame);
  }
  async function frameDocument(html, channel) {
    const urls = new Set();
    for (const match of html.matchAll(/<script\b[^>]*?\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi)) urls.add(match[2]);
    for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
      if (!/\brel\s*=\s*(["'])[^"']*\bstylesheet\b[^"']*\1/i.test(match[1])) continue;
      const href = match[1].match(/\bhref\s*=\s*(["'])([^"']+)\1/i);
      if (href) urls.add(href[2]);
    }
    const assets = new Map();
    await Promise.all(
      [...urls].map(async (url) => {
        const path = localDocumentAssetPath(url, entry);
        if (path) assets.set(url, await readAsset(uiRoot, path));
      }),
    );
    return sandboxDocument(html, channel, assets);
  }
  function expose(frame) {
    const { session: _session, page: _page, ...safe } = frame;
    return structuredClone(safe);
  }
  function frameFor(session, id) {
    const f = frames.get(id);
    if (!f || f.session !== session.id || f.page !== session.page) throw new Error("Unknown workbench frame");
    return f;
  }
  async function bridge(session, input) {
    const frame = frameFor(session, input.frameId),
      p = input.params || {};
    if (input.channel !== frame.channel) throw new Error("Stale workbench generation");
    if (input.method !== "backend.sendBinary" && jsonSize(p) > BRIDGE_LIMIT) throw new Error("Bridge request exceeds 2 MiB");
    switch (input.method) {
      case "host.getContext":
        return structuredClone(frame.context);
      case "backend.invoke": {
        if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== "number" || !Number.isFinite(p.timeoutMs))) throw new Error("Invalid request timeout");
        const timeout = p.timeoutMs === undefined ? 30000 : Math.min(120000, Math.max(1, Math.round(p.timeoutMs)));
        return sidecar.request(protocolName(p.method), p.params ?? null, timeout);
      }
      case "backend.notify":
        await sidecar.notify(protocolName(p.method), p.params ?? null);
        return null;
      case "backend.sendBinary": {
        requirePermission(manifest, "host.binary");
        if (typeof p.dataBase64 !== "string" || p.dataBase64.length > Math.ceil(UI_BINARY_LIMIT / 3) * 4) throw new Error("Invalid base64 or binary exceeds limit");
        const data = Buffer.from(p.dataBase64, "base64");
        if (data.toString("base64") !== p.dataBase64) throw new Error("Invalid base64");
        if (data.length > UI_BINARY_LIMIT) throw new Error("Bridge binary exceeds 8 MiB");
        await sidecar.sendBinary(p.channel, data);
        return null;
      }
      case "ui.readAsset": {
        const prefix = (manifest.entrypoints.ui.root || "ui").replace(/\/$/, "") + "/";
        const path = typeof p.path === "string" && p.path.startsWith(prefix) ? p.path.slice(prefix.length) : p.path;
        return readAsset(uiRoot, path);
      }
      case "host.openWorkbench": {
        requirePermission(manifest, "host.workbench");
        return { mockHostOpenFrame: await serialize(() => openFrame(session, p.context?.connectionId || frame.connectionId, p.contributionId, p.context)) };
      }
      default:
        throw new Error(`Unsupported mock host method: ${input.method}`);
    }
  }
  async function api(session, route, p) {
    if (route === "/api/bridge") return bridge(session, p);
    if (route === "/api/frame-document") {
      const f = frameFor(session, p.frameId);
      const asset = await readAsset(uiRoot, entry);
      f.channel = randomUUID();
      return { ...expose(f), html: await frameDocument(Buffer.from(asset.dataBase64, "base64").toString("utf8"), f.channel) };
    }
    return serialize(async () => {
      switch (route) {
        case "/api/auto-reload": {
          if (typeof p.enabled !== "boolean") throw new Error("Invalid automatic reload setting");
          autoReload = p.enabled;
          backendReload.enable(autoReload);
          broadcast("auto-reload", { enabled: autoReload });
          diagnostics.record("info", "build", autoReload ? "自动重载已启用" : "自动重载已关闭");
          return { enabled: autoReload };
        }
        case "/api/workbenches/open":
          return { frame: await openFrame(session, undefined, p.contributionId) };
        case "/api/connections/edit":
          return store.get(p.id);
        case "/api/connections/save": {
          const existing = p.id ? store.get(p.id) : undefined;
          const record = validateRecord(manifest, p);
          if (existing && existing.providerId !== record.providerId) throw new Error("Create a new connection to change its provider");
          if (existing) await disconnect(existing.id);
          await store.replace([...store.records.filter((r) => r.id !== record.id), record]);
          return { connections: listing(), id: record.id };
        }
        case "/api/connections/test": {
          const record = validateRecord(manifest, { ...p, id: randomUUID() });
          if (!providerFor(manifest, record.providerId).capabilities?.includes("test")) throw new Error("Provider does not support test");
          ensureSucceeded(await sidecar.request("connection/test", lifecyclePayload(manifest, record), 60000));
          return { message: "连接测试成功" };
        }
        case "/api/connections/connect":
          return { frame: await openFrame(session, p.id), connections: listing() };
        case "/api/connections/disconnect":
          await disconnect(p.id);
          return { connections: listing() };
        case "/api/connections/delete": {
          store.get(p.id);
          await disconnect(p.id);
          await store.replace(store.records.filter((r) => r.id !== p.id));
          for (const f of frames.values()) if (f.connectionId === p.id) frames.delete(f.id);
          broadcast("frames-removed", { connectionId: p.id });
          return { connections: listing() };
        }
        case "/api/connections/import": {
          if (!Array.isArray(p.connections) || p.connections.length > 100) throw new Error("Invalid connection import");
          const imported = p.connections.map((r) => validateRecord(manifest, { ...r, id: randomUUID() }));
          await store.replace([...store.records, ...imported]);
          return { connections: listing() };
        }
        case "/api/frames/close": {
          const f = frameFor(session, p.id);
          if (f.connectionId && ![...frames.values()].some((other) => other.id !== f.id && other.connectionId === f.connectionId)) await disconnect(f.connectionId);
          frames.delete(f.id);
          return { connections: listing() };
        }
        case "/api/backend/restart":
          return restartBackend();
        default:
          throw new Error("Unknown mock host endpoint");
      }
    });
  }
  async function restartBackend() {
    restarting = true;
    diagnostics.record("info", "build", "开始重建后端");
    try {
      for (const id of connected) await disconnect(id).catch(() => connected.delete(id));
      await sidecar.stop();
      if (options.buildBackend) await options.buildBackend();
      await sidecar.start();
      diagnostics.record("info", "build", "后端重建完成");
      return { connections: listing(), state: sidecar.state };
    } catch (error) {
      diagnostics.record("error", "build", "后端重建失败");
      throw error;
    } finally {
      restarting = false;
    }
  }
  const server = http.createServer(async (request, response) => {
    const started = performance.now();
    let route = "unknown",
      rejection;
    response.on("finish", () => {
      if (route === "diagnostics" || route === "events" || (route === "bootstrap" && response.statusCode < 400)) return;
      diagnostics.record(response.statusCode >= 400 ? "error" : "debug", "http", "HTTP 请求完成", {
        method: route,
        path: route === "unknown" ? "[unknown route]" : route.startsWith("/") ? route : `/api/${route}`,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started),
        reason: rejection,
      });
    });
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (request.headers.host !== new URL(origin).host) {
        rejection = "invalid-host";
        return respond(response, 403, { error: { message: "Invalid Host" } });
      }
      if (request.headers["sec-fetch-site"] === "cross-site" || (request.headers.origin && request.headers.origin !== origin)) {
        rejection = "invalid-origin";
        return respond(response, 403, { error: { message: "Invalid Origin" } });
      }
      const path = new URL(request.url, origin).pathname;
      const known = [
        "/",
        "/api/bootstrap",
        "/api/events",
        "/api/bridge",
        "/api/frame-document",
        "/api/workbenches/open",
        "/api/connections/edit",
        "/api/connections/save",
        "/api/connections/test",
        "/api/connections/connect",
        "/api/connections/disconnect",
        "/api/connections/delete",
        "/api/connections/import",
        "/api/frames/close",
        "/api/backend/restart",
      ];
      route = known.includes(path) ? path.replace("/api/", "") || "/" : "unknown";
      if (path === "/api/diagnostics") {
        route = "diagnostics";
        if (request.method !== "GET") return respond(response, 405, { error: { message: "Diagnostics is read-only; use GET" } });
        return respond(response, 200, { ...diagnostics.query(new URL(request.url, origin).searchParams), plugin: { id: manifest.id, version: manifest.version }, backendState: sidecar.state, port: server.address().port });
      }
      const cookie = (request.headers.cookie || "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      let session = sessions.get(cookie);
      if (path === "/api/bootstrap" && request.method === "GET") {
        if (!session) {
          if (sessions.size >= 128) throw new Error("Too many browser sessions");
          session = { id: randomBytes(24).toString("hex"), csrf: randomBytes(24).toString("hex") };
          sessions.set(session.id, session);
          response.setHeader("Set-Cookie", `${cookieName}=${session.id}; HttpOnly; SameSite=Strict; Path=/`);
        }
        return respond(response, 200, { manifest, connections: listing(), csrf: session.csrf, state: sidecar.state, revision, autoReload, diagnostics: diagnostics.snapshot() });
      }
      if (path === "/api/events" && request.method === "GET" && session) {
        const page = pageId(new URL(request.url, origin).searchParams.get("page") || undefined);
        const key = `${session.id}:${page}`;
        let lease = pages.get(key);
        if (!lease) {
          lease = { count: 0 };
          pages.set(key, lease);
        }
        clearTimeout(lease.timer);
        lease.count++;
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        response.write(`data: ${JSON.stringify({ type: "page-frames", ids: [...frames.values()].filter((f) => f.session === session.id && f.page === page).map((f) => f.id) })}\n\n`);
        response.write(`data: ${JSON.stringify({ type: "status", state: sidecar.state })}\n\n`);
        streams.add(response);
        response.write(`data: ${JSON.stringify({ type: "auto-reload", enabled: autoReload })}\n\n`);
        response.write(`data: ${JSON.stringify({ type: "diagnostic-history", entries: diagnostics.snapshot() })}\n\n`);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20000);
        response.on("close", () => {
          streams.delete(response);
          clearInterval(heartbeat);
          if (--lease.count || closing) return;
          // Keep frames during EventSource reconnects; retire abandoned browser pages.
          lease.timer = setTimeout(() => {
            void serialize(async () => {
              if (closing || lease.count || pages.get(key) !== lease) return;
              pages.delete(key);
              const ids = new Set();
              for (const f of frames.values()) {
                if (f.session !== session.id || f.page !== page) continue;
                frames.delete(f.id);
                if (f.connectionId) ids.add(f.connectionId);
              }
              for (const id of ids) {
                if ([...frames.values()].some((f) => f.connectionId === id)) continue;
                try {
                  await disconnect(id);
                } catch {
                  diagnostics.record("error", "backend", "页面回收时断开连接失败");
                }
              }
              broadcast("connections", { connections: listing() });
            });
          }, options.pageGraceMs ?? 30000);
        });
        return;
      }
      if (path.startsWith("/api/")) {
        if (request.method !== "POST" || !session || request.headers.origin !== origin || request.headers["x-mock-csrf"] !== session.csrf || !request.headers["content-type"]?.startsWith("application/json")) {
          rejection = request.method !== "POST" ? "invalid-method" : !session ? "missing-or-expired-session" : request.headers.origin !== origin ? "missing-origin" : request.headers["x-mock-csrf"] !== session.csrf ? "csrf-mismatch" : "invalid-content-type";
          return respond(response, 403, { error: { message: "Invalid browser session or request" } });
        }
        let bytes = 0;
        const chunks = [];
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 12 * 1024 * 1024) throw new Error("HTTP payload exceeds limit");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const page = pageId(request.headers["x-dbx-page"]);
        return respond(response, 200, { value: await api({ ...session, page }, path, body) });
      }
      if (path === "/" && request.method === "GET") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        );
        return response.end(await readFile(options.shellHtml));
      }
      respond(response, 404, { error: { message: "Not found" } });
    } catch (error) {
      const rpc = error.rpc;
      rejection = rpc ? "backend-error" : error.message?.startsWith("Plugin permission required:") ? "permission-denied" : error.message?.startsWith("Unsupported mock host method:") ? "unsupported-method" : error.message === "Stale workbench generation" ? "stale-frame" : "operation-failed";
      // Do not reflect raw filesystem/process errors, paths or request bodies.
      const message = error.code ? "Local development service operation failed" : error.message;
      respond(response, 400, { error: { message, ...(rpc ? { code: rpc.code, data: rpc.data } : {}) } });
    }
  });
  server.requestTimeout = 320000;
  try {
    await new Promise((accept, reject) => {
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE") {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", accept);
        } else reject(error);
      });
      server.listen(options.port ?? 5190, "127.0.0.1", accept);
    });
  } catch (error) {
    await sidecar.stop();
    throw error;
  }
  origin = `http://127.0.0.1:${server.address().port}`;
  // Cookies are scoped by host, not port; concurrent development hosts need distinct names.
  cookieName = `dbx_dev_session_${server.address().port}`;
  diagnostics.context = { port: server.address().port };
  diagnostics.record("info", "server", "调试服务已启动", { port: server.address().port, project, uiRoot, backend: options.backend });
  const watchStop = new AbortController();
  if (options.backendWatch && options.buildBackend)
    void (async () => {
      try {
        for await (const event of watch(options.backendWatch, { signal: watchStop.signal, recursive: true })) {
          const path = String(event.filename || "").replaceAll("\\", "/");
          if (path.split("/").some((p) => ["target", ".git", ".dbx-dev", "node_modules", "vendor"].includes(p))) continue;
          if (/\.(rs|go)$|(^|\/)(Cargo\.toml|Cargo\.lock|build\.rs|go\.mod|go\.sum)$/.test(path)) backendReload.changed();
        }
      } catch (error) {
        if (error.name !== "AbortError") {
          diagnostics.record("error", "build", "后端源码监听已停止");
          broadcast("auto-reload-error", {});
        }
      }
    })();
  let debounce;
  void (async () => {
    try {
      for await (const _event of watch(uiRoot, { signal: watchStop.signal, recursive: true })) {
        if (options.uiBuildSignals) continue;
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          try {
            await readAsset(uiRoot, entry);
            broadcast("ui-rebuilt", { revision: ++revision });
          } catch {
            broadcast("watch-error", {});
          }
        }, 500);
      }
    } catch (error) {
      if (error.name !== "AbortError") broadcast("watch-error", {});
    }
  })();
  return {
    origin,
    server,
    sidecar,
    store,
    diagnostics,
    async uiBuilt() {
      await readAsset(uiRoot, entry);
      broadcast("ui-rebuilt", { revision: ++revision });
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const lease of pages.values()) clearTimeout(lease.timer);
      pages.clear();
      backendReload.enable(false);
      watchStop.abort();
      clearTimeout(debounce);
      for (const stream of streams) stream.end();
      streams.clear();
      server.close();
      await serialize(async () => {
        for (const id of connected) await disconnect(id).catch(() => {});
        await sidecar.stop();
      });
      server.closeAllConnections();
      diagnostics.record("info", "server", "调试服务已停止");
      diagnostics.removeListener("entry", onDiagnostic);
    },
  };
}
function respond(response, code, value) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
