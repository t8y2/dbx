import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionConfig } from "../src/connections.js";
import { buildConnectionUrl } from "../src/database.js";

function mysqlConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "mysql-test",
    name: "mysql",
    db_type: "mysql",
    host: "mysql.example.com",
    port: 3306,
    username: "root",
    password: "secret",
    database: "app",
    ssl: false,
    ...overrides,
  };
}

test("mysql MCP URL does not enable TLS by default", () => {
  const url = buildConnectionUrl(mysqlConfig(), { host: "mysql.example.com", port: 3306 });

  assert.equal(url, "mysql://root:secret@mysql.example.com:3306/app");
});

test("mysql MCP URL preserves explicit preferred TLS mode", () => {
  const url = buildConnectionUrl(mysqlConfig({ url_params: "ssl-mode=preferred" }), {
    host: "mysql.example.com",
    port: 3306,
  });

  assert.equal(url, "mysql://root:secret@mysql.example.com:3306/app?ssl-mode=preferred");
});
