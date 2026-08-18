import assert from "node:assert/strict";
import { test } from "vitest";
import { issueRedirectPath, sanitizeReturnTo, signPayload, verifySignedPayload } from "../worker";

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

test("anonymous Issue aliases redirect to one localized route", () => {
  assert.equal(issueRedirectPath("/issue", "cn"), "/cn/issue");
  assert.equal(issueRedirectPath("/issues/", "en"), "/en/issue");
  assert.equal(issueRedirectPath("/cn/issues", "en"), "/cn/issue");
  assert.equal(issueRedirectPath("/cn/issue", "cn"), null);
});
