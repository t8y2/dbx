import assert from "node:assert/strict";
import { test } from "vitest";
import { issueRedirectPath, sanitizeReturnTo, signPayload, staticAssetCacheControl, verifySignedPayload } from "../worker";

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

test("static assets receive browser cache headers without caching HTML", () => {
  assert.equal(staticAssetCacheControl("/_next/static/chunks/app-123.js"), "public, max-age=31536000, immutable");
  assert.equal(staticAssetCacheControl("/screenshots/dbx-light-1280.webp"), "public, max-age=86400, stale-while-revalidate=604800");
  assert.equal(staticAssetCacheControl("/cn"), null);
  assert.equal(staticAssetCacheControl("/cn/changelog.txt"), null);
});
