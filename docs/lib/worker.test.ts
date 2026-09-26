import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import worker, { issueRedirectPath, pluginDetailShellRequest, sanitizeReturnTo, signPayload, staticAssetCacheControl, verifySignedPayload } from "../worker";

test("native installers bypass HTML routing and are served as plain text", async () => {
  const wrangler = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
  for (const pathname of ["/install-mcp", "/install-mcp.ps1"]) {
    assert.ok(wrangler.assets.run_worker_first.includes(pathname));
    const source = readFileSync(new URL(`../public/${pathname === "/install-mcp" ? "install-mcp.sh" : "install-mcp.ps1"}`, import.meta.url), "utf8");
    const env = { ASSETS: { fetch: async (request: Request) => {
      assert.equal(new URL(request.url).pathname, pathname === "/install-mcp" ? "/install-mcp.sh" : pathname);
      return new Response(source);
    } } };
    const response = await worker.fetch(new Request(`https://dbxio.com${pathname}`), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), source);
    assert.equal(await (await worker.fetch(new Request(`https://dbxio.com${pathname}`, { method: "HEAD" }), env)).text(), "");
    assert.equal((await worker.fetch(new Request(`https://dbxio.com${pathname}`, { method: "POST" }), env)).status, 405);
    for (const status of [200, 404]) {
      const missing = await worker.fetch(new Request(`https://dbxio.com${pathname}`), {
        ASSETS: { fetch: async () => new Response("<html>not found</html>", { status, headers: { "Content-Type": "text/html" } }) },
      });
      assert.equal(missing.status, 503);
      assert.equal(missing.headers.get("Cache-Control"), "no-store");
      assert.doesNotMatch(await missing.text(), /<html>/);
    }
  }
});

test("plugin detail shell routes are routed to the worker before static 404 handling", () => {
  const wrangler = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
  const runWorkerFirst: string[] = wrangler.assets.run_worker_first;
  for (const prefix of ["/cn/plugins", "/en/plugins"]) {
    assert.ok(
      runWorkerFirst.includes(`${prefix}/*`),
      `${prefix}/* missing from run_worker_first; the asset layer would serve the static 404 before the worker shell fallback runs`,
    );
  }
});

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

test("plugin detail fallback maps unknown ids onto the shell route", () => {
  const shell = pluginDetailShellRequest(new URL("https://dbxio.com/cn/plugins/io.github.t8y2.s3"), new Request("https://dbxio.com/cn/plugins/io.github.t8y2.s3"));
  assert.equal(shell?.url, "https://dbxio.com/cn/plugins/detail?id=io.github.t8y2.s3");

  const encoded = pluginDetailShellRequest(new URL("https://dbxio.com/en/plugins/a%20b"), new Request("https://dbxio.com/en/plugins/a%20b"));
  assert.equal(encoded?.url, "https://dbxio.com/en/plugins/detail?id=a%2520b");

  // The shell route itself and non-GET requests must pass through untouched.
  assert.equal(pluginDetailShellRequest(new URL("https://dbxio.com/en/plugins/detail"), new Request("https://dbxio.com/en/plugins/detail")), null);
  assert.equal(
    pluginDetailShellRequest(new URL("https://dbxio.com/en/plugins/io.dbx.ssh"), new Request("https://dbxio.com/en/plugins/io.dbx.ssh", { method: "POST" })),
    null,
  );
  assert.equal(pluginDetailShellRequest(new URL("https://dbxio.com/en/plugins"), new Request("https://dbxio.com/en/plugins")), null);
});
