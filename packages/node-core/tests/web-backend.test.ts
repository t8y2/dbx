import assert from "node:assert/strict";
import { afterEach, test } from "vitest";

import { executeQuery, loadConnections, resetWebAuthForTests } from "../src/web-backend.js";

const originalFetch = globalThis.fetch;
const originalWebUrl = process.env.DBX_WEB_URL;
const originalWebPassword = process.env.DBX_WEB_PASSWORD;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWebUrl === undefined) delete process.env.DBX_WEB_URL;
  else process.env.DBX_WEB_URL = originalWebUrl;
  if (originalWebPassword === undefined) delete process.env.DBX_WEB_PASSWORD;
  else process.env.DBX_WEB_PASSWORD = originalWebPassword;
  resetWebAuthForTests();
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
}

test("web backend rejects protected DBX Web access without DBX_WEB_PASSWORD", async () => {
  process.env.DBX_WEB_URL = "http://127.0.0.1:4224";
  delete process.env.DBX_WEB_PASSWORD;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/auth/check")) {
      return jsonResponse({ authenticated: false, required: true, setup_required: false });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  await assert.rejects(loadConnections(), /DBX_WEB_PASSWORD/);
  assert.deepEqual(calls, ["http://127.0.0.1:4224/api/auth/check"]);
});

test("web backend rejects DBX Web access before password setup is complete", async () => {
  process.env.DBX_WEB_URL = "http://127.0.0.1:4224";
  delete process.env.DBX_WEB_PASSWORD;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/auth/check")) {
      return jsonResponse({ authenticated: false, required: false, setup_required: true });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  await assert.rejects(loadConnections(), /password setup is required/);
  assert.deepEqual(calls, ["http://127.0.0.1:4224/api/auth/check"]);
});

test("web backend logs in with DBX_WEB_PASSWORD and sends the session cookie", async () => {
  process.env.DBX_WEB_URL = "http://127.0.0.1:4224/";
  process.env.DBX_WEB_PASSWORD = "secret";
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/auth/check")) {
      return jsonResponse({ authenticated: false, required: true, setup_required: false });
    }
    if (url.endsWith("/api/auth/login")) {
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, JSON.stringify({ password: "secret" }));
      return jsonResponse({ ok: true }, { headers: { "set-cookie": "dbx_session=session-1; Path=/; HttpOnly" } });
    }
    if (url.endsWith("/api/connection/list")) {
      assert.equal((init?.headers as Record<string, string>).Cookie, "dbx_session=session-1");
      return jsonResponse([
        {
          id: "1",
          name: "local",
          db_type: "postgres",
          host: "127.0.0.1",
          port: 5432,
          username: "app",
          password: "",
          database: "demo",
          ssh_enabled: false,
          ssl: false,
        },
      ]);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const connections = await loadConnections();

  assert.equal(connections[0]?.name, "local");
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "http://127.0.0.1:4224/api/auth/check",
      "http://127.0.0.1:4224/api/auth/login",
      "http://127.0.0.1:4224/api/connection/list",
    ],
  );
});

test("web backend still allows DBX Web instances with password auth disabled", async () => {
  process.env.DBX_WEB_URL = "http://127.0.0.1:4224";
  delete process.env.DBX_WEB_PASSWORD;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/auth/check")) {
      return jsonResponse({ authenticated: true, required: false, setup_required: false });
    }
    if (url.endsWith("/api/connection/list")) {
      assert.equal((init?.headers as Record<string, string>).Cookie, undefined);
      return jsonResponse([]);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  assert.deepEqual(await loadConnections(), []);
});

test("web backend executes concurrent SQL queries without pre-connecting", async () => {
  process.env.DBX_WEB_URL = "http://127.0.0.1:4224";
  delete process.env.DBX_WEB_PASSWORD;
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/auth/check")) {
      return jsonResponse({ authenticated: true, required: false, setup_required: false });
    }
    if (url.endsWith("/api/connection/connect")) {
      throw new Error("query execution should not call /api/connection/connect");
    }
    if (url.endsWith("/api/query/execute")) {
      const body = JSON.parse(String(init?.body)) as { sql: string };
      const n = Number(body.sql.match(/select\s+(\d+)/i)?.[1] ?? 0);
      return jsonResponse({
        columns: ["n"],
        rows: [[n]],
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const config = {
    id: "oracle-1",
    name: "Oracle",
    db_type: "oracle",
    host: "127.0.0.1",
    port: 1521,
    username: "app",
    password: "",
    database: "orcl",
    ssh_enabled: false,
    ssl: false,
  } as const;
  const results = await Promise.all([1, 2, 3, 4].map((n) => executeQuery(config, `select ${n} as n from dual`)));

  assert.deepEqual(
    results.map((result) => result.rows[0]?.n),
    [1, 2, 3, 4],
  );
  assert.equal(calls.filter((url) => url.endsWith("/api/connection/connect")).length, 0);
  assert.equal(calls.filter((url) => url.endsWith("/api/query/execute")).length, 4);
});
