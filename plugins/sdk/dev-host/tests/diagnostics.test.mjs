import test from "node:test";
import assert from "node:assert/strict";
import { Diagnostics, redact } from "../diagnostics.mjs";

test("diagnostics bound history and serialize only allowed metadata", () => {
  const lines = [],
    log = new Diagnostics((line) => lines.push(line));
  let emitted;
  log.on("entry", (entry) => {
    emitted = entry;
  });
  for (let n = 0; n < 505; n++)
    log.record("debug", "rpc", "RPC 完成", {
      requestId: n,
      durationMs: 3,
      method: "example/echo",
      params: { password: "private-value" },
      result: { count: 3, access_token: "private-value" },
      cookie: "private-value",
    });
  const entries = log.snapshot();
  assert.equal(entries.length, 500);
  assert.equal(entries[0].id, 6);
  assert.equal(emitted.id, 505);
  assert.equal(
    lines.some((line) => line.includes("private-value")),
    false,
  );
  assert.deepEqual(entries[0].details, { requestId: 5, durationMs: 3, method: "example/echo", params: { password: "[REDACTED]" }, result: { count: 3, access_token: "[REDACTED]" } });
  entries[0].details.method = "changed";
  assert.equal(log.snapshot()[0].details.method, "example/echo");
});

test("payload diagnostics retain types and paths while redacting nested secrets and bounding content", () => {
  const input = { path: "/folder/test.txt", port: 9000, enabled: false, nested: [{ credential: "private", custom: "private" }], url: "https://user:private@example.com/path?token=private", dataBase64: "private", text: "a".repeat(10000) };
  const safe = redact(input, new Set(["custom"]));
  assert.equal(safe.path, input.path);
  assert.equal(safe.port, 9000);
  assert.equal(safe.enabled, false);
  assert.equal(JSON.stringify(safe).includes("private"), false);
  assert.match(safe.text, /truncated/);
  assert.ok(safe.text.length < 2100);
  assert.equal(input.nested[0].custom, "private");
  const cycle = {};
  cycle.self = cycle;
  assert.equal(redact(cycle).self, "[circular]");
});

test("diagnostic queries paginate, filter and detect overwritten history and restarts", () => {
  const log = new Diagnostics(() => {});
  for (let i = 0; i < 503; i++) log.record(i % 2 ? "error" : "info", "rpc", "RPC 完成");
  const first = log.query(new URLSearchParams("limit=2&level=error"));
  assert.equal(first.entries.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(first.truncated, true);
  const next = log.query(new URLSearchParams(`after=${first.nextAfter}&level=error&limit=500`));
  assert.ok(next.entries.every((e) => e.id > first.nextAfter && e.level === "error"));
  assert.equal(next.nextAfter, 503);
  assert.equal(next.hasMore, false);
  assert.equal(log.query(new URLSearchParams("after=503")).entries.length, 0);
  assert.equal(log.query(new URLSearchParams("after=503&instanceId=old")).reset, true);
  for (const query of ["limit=0", "after=-1", "limit=501", "level=unknown", "after=1&after=2", "token=secret"]) assert.throws(() => log.query(new URLSearchParams(query)));
});
