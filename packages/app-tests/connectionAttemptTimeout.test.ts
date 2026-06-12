import { strict as assert } from "node:assert";
import { test } from "vitest";
import { CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS, MONGO_LEGACY_FALLBACK_TIMEOUT_BUFFER_MS, connectionAttemptTimeoutMessage, connectionAttemptTimeoutMs } from "../../apps/desktop/src/lib/connectionAttemptTimeout.ts";

test("uses connection timeout with a small UI buffer", () => {
  assert.equal(connectionAttemptTimeoutMs({ connect_timeout_secs: 8 }), 8_000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS);
});

test("falls back to the default connection timeout", () => {
  assert.equal(connectionAttemptTimeoutMs({}), 5_000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS);
  assert.equal(connectionAttemptTimeoutMs({ connect_timeout_secs: 0 }), 5_000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS);
});

test("honors slower SSH tunnel connection timeouts", () => {
  assert.equal(
    connectionAttemptTimeoutMs({
      connect_timeout_secs: 5,
      transport_layers: [{ type: "ssh", id: "hop-1", host: "bastion", port: 22, user: "dbx", connect_timeout_secs: 20 }],
    }),
    20_000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS,
  );
});

test("allows MongoDB legacy agent fallback after native driver timeout", () => {
  assert.equal(connectionAttemptTimeoutMs({ db_type: "mongodb", connect_timeout_secs: 5 }), 5_000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS + MONGO_LEGACY_FALLBACK_TIMEOUT_BUFFER_MS);
});

test("uses a shared minimum timeout for built-in agent drivers", () => {
  assert.equal(connectionAttemptTimeoutMs({ db_type: "saphana", connect_timeout_secs: 5 }), 15_000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS);
  assert.equal(connectionAttemptTimeoutMs({ db_type: "db2", connect_timeout_secs: 5 }), 15_000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS);
  assert.equal(connectionAttemptTimeoutMs({ db_type: "oracle", connect_timeout_secs: 20 }), 20_000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS);
});

test("formats connection attempt timeout messages", () => {
  assert.match(connectionAttemptTimeoutMessage(7_001), /timed out after 8s/);
  assert.match(connectionAttemptTimeoutMessage(7_001), /VPN/);
});
