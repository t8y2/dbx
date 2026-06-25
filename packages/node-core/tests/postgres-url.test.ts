import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionConfig } from "../src/connections.js";
import { buildConnectionUrl } from "../src/database.js";

function postgresConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "pg-test",
    name: "pg",
    db_type: "postgres",
    host: "pg.example.com",
    port: 5432,
    username: "postgres",
    password: "secret",
    database: "app",
    ssl: false,
    ...overrides,
  };
}

test("postgres MCP URL adds sslmode=require when TLS is enabled", () => {
  const url = buildConnectionUrl(postgresConfig({ ssl: true }), { host: "pg.example.com", port: 5432 });

  assert.equal(url, "postgres://postgres:secret@pg.example.com:5432/app?sslmode=require");
});

test("postgres MCP URL keeps explicit sslmode", () => {
  const url = buildConnectionUrl(postgresConfig({ ssl: true, url_params: "sslmode=verify-full&application_name=dbx" }), {
    host: "pg.example.com",
    port: 5432,
  });

  assert.equal(url, "postgres://postgres:secret@pg.example.com:5432/app?sslmode=verify-full&application_name=dbx");
});

test("postgres MCP URL maps ssl-mode to sslmode", () => {
  const url = buildConnectionUrl(postgresConfig({ url_params: "ssl-mode=required" }), {
    host: "pg.example.com",
    port: 5432,
  });

  assert.equal(url, "postgres://postgres:secret@pg.example.com:5432/app?sslmode=require");
});

test("postgres MCP URL drops MySQL-style TLS params", () => {
  const url = buildConnectionUrl(
    postgresConfig({
      url_params: "ssl-mode=required&verify_ca=false&verify_identity=false&require_ssl=true&charset=utf8mb4&application_name=dbx",
    }),
    { host: "pg.example.com", port: 5432 },
  );

  assert.equal(url, "postgres://postgres:secret@pg.example.com:5432/app?sslmode=require&application_name=dbx");
});

test("postgres MCP URL maps schema and timezone to options", () => {
  const url = buildConnectionUrl(postgresConfig({ url_params: "schema=app&timezone=UTC" }), {
    host: "pg.example.com",
    port: 5432,
  });

  assert.equal(url, "postgres://postgres:secret@pg.example.com:5432/app?options=-c%20search_path%3Dapp%20-c%20TimeZone%3DUTC");
});

test("pooled URL builder rejects non-pooled direct types", () => {
  assert.throws(
    () => buildConnectionUrl(postgresConfig({ db_type: "sqlite", host: "/tmp/app.db", port: 0 }), { host: "/tmp/app.db", port: 0 }),
    /Unsupported pooled connection type: sqlite/,
  );
});
