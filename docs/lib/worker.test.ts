import assert from "node:assert/strict";
import { test } from "vitest";
import { sanitizeReturnTo, signPayload, verifySignedPayload } from "../worker";

test("signed OAuth payloads round-trip and reject tampering", async () => {
  const signed = await signPayload({ login: "dbx-user" }, "test-secret");
  assert.deepEqual(await verifySignedPayload<{ login: string }>(signed, "test-secret"), { login: "dbx-user" });
  assert.equal(await verifySignedPayload(`${signed}x`, "test-secret"), null);
});

test("OAuth return paths stay on the DBX origin", () => {
  assert.equal(sanitizeReturnTo("/cn/contributors"), "/cn/contributors");
  assert.equal(sanitizeReturnTo("//evil.example"), "/en/contributors");
  assert.equal(sanitizeReturnTo("https://evil.example"), "/en/contributors");
});
