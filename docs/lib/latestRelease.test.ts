import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { fetchLatestReleaseInfo } from "./latestRelease";

afterEach(() => {
  vi.restoreAllMocks();
});

test("latest release metadata uses only the static R2 endpoint", async () => {
  const requestedUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      requestedUrls.push(String(input));
      return Response.json({ version: "v0.5.66", notes: "Static metadata" });
    }),
  );

  assert.deepEqual(await fetchLatestReleaseInfo(), { version: "0.5.66", notes: "Static metadata" });
  assert.deepEqual(requestedUrls, ["https://dl.dbxio.com/releases/latest/latest.json"]);
});

test("latest release metadata fails closed without a GitHub API fallback", async () => {
  const requestedUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      requestedUrls.push(String(input));
      return new Response("unavailable", { status: 503 });
    }),
  );

  assert.equal(await fetchLatestReleaseInfo(), null);
  assert.deepEqual(requestedUrls, ["https://dl.dbxio.com/releases/latest/latest.json"]);
});

test("latest release metadata keeps the release tag of a promoted beta", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ version: "0.6.63", release_tag: "v0.6.63-beta.20261101.3" })),
  );

  assert.deepEqual(await fetchLatestReleaseInfo(), { version: "0.6.63", release_tag: "v0.6.63-beta.20261101.3" });
});
