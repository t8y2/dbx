import assert from "node:assert/strict";
import test from "node:test";
import { staleConnectionMessage, shouldMarkDisconnected } from "../../apps/desktop/src/lib/connectionHealth.ts";

test("metadata connection errors should turn off connected state", () => {
  assert.equal(shouldMarkDisconnected(new Error("connection closed by server")), true);
  assert.equal(shouldMarkDisconnected("broken pipe"), true);
  assert.equal(shouldMarkDisconnected("operation timed out"), true);
});

test("non-connection metadata errors should not turn off connected state", () => {
  assert.equal(shouldMarkDisconnected(new Error("permission denied for table users")), false);
  assert.equal(shouldMarkDisconnected("syntax error near SELECT"), false);
});

test("stale connection errors keep the original backend message", () => {
  assert.equal(staleConnectionMessage(new Error("connection reset by peer")), "connection reset by peer");
  assert.equal(staleConnectionMessage("closed"), "closed");
});
