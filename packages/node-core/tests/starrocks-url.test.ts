import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionConfig } from "../src/connections.js";
import { buildConnectionUrl } from "../src/database.js";

function starrocksConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "sr-1",
    name: "starrocks",
    db_type: "starrocks",
    host: "fe-example.starrocks.aliyuncs.com",
    port: 9030,
    username: "admin",
    password: "secret",
    database: "analytics",
    ssl: false,
    ...overrides,
  };
}

test("starrocks omits tls params when ssl is disabled", () => {
  const url = buildConnectionUrl(
    starrocksConfig({
      url_params: "ssl-mode=disabled&require_ssl=true&verify_ca=true&charset=utf8mb4",
    }),
    { host: "fe-example.starrocks.aliyuncs.com", port: 9030 },
  );

  assert.equal(url, "mysql://admin:secret@fe-example.starrocks.aliyuncs.com:9030/analytics");
});

test("starrocks preserves tls params when ssl is enabled", () => {
  const url = buildConnectionUrl(
    starrocksConfig({
      ssl: true,
      url_params: "verify_ca=true&verify_identity=false",
    }),
    { host: "fe-example.starrocks.aliyuncs.com", port: 9030 },
  );

  assert.equal(
    url,
    "mysql://admin:secret@fe-example.starrocks.aliyuncs.com:9030/analytics?require_ssl=true&verify_ca=true&verify_identity=false&charset=utf8mb4",
  );
});

test("mysql starrocks profile preserves tls params when ssl is enabled", () => {
  const url = buildConnectionUrl(
    starrocksConfig({
      db_type: "mysql",
      driver_profile: "starrocks",
      ssl: true,
      ca_cert_path: "/tmp/ca.pem",
    }),
    { host: "fe-example.starrocks.aliyuncs.com", port: 9030 },
  );

  assert.equal(
    url,
    "mysql://admin:secret@fe-example.starrocks.aliyuncs.com:9030/analytics?require_ssl=true&verify_identity=false&charset=utf8mb4",
  );
});
