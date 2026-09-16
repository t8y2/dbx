import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { changelogIndexUrl, changelogReleaseUrl, changelogUrl, fetchChangelog, loadChangelogBootstrap } from "./changelog";
import { isAppReleaseTag } from "./releaseTags";

afterEach(() => {
  vi.restoreAllMocks();
});

test("recognizes only DBX app release tags", () => {
  assert.equal(isAppReleaseTag("v0.5.66"), true);
  assert.equal(isAppReleaseTag("v1.2.3-hotfix.1"), true);
  assert.equal(isAppReleaseTag("packages-v0.4.42"), false);
  assert.equal(isAppReleaseTag("agents-v0.2.64"), false);
  assert.equal(isAppReleaseTag("v0.5.x"), false);
});

test("builds index and per-release URLs under the changelog base", () => {
  assert.equal(changelogUrl("cn"), "https://dl.dbxio.com/changelog/releases-cn.json");
  assert.equal(changelogIndexUrl("en"), "https://dl.dbxio.com/changelog/index-en.json");
  assert.equal(changelogReleaseUrl("cn", "v1.2.3"), "https://dl.dbxio.com/changelog/releases-cn/v1.2.3.json");
});

test("changelog build fails without falling back to GitHub API", async () => {
  const requestedUrls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      requestedUrls.push(String(input));
      return new Response("unavailable", { status: 503 });
    }),
  );

  await assert.rejects(fetchChangelog("cn"), /Request failed with status 503/);
  assert.deepEqual(requestedUrls, ["https://dl.dbxio.com/changelog/releases-cn.json"]);
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("bootstrap prefers the index and per-release files when published", async () => {
  const requestedUrls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/index-cn.json")) {
        return jsonResponse({ updatedAt: "2026-08-26T00:00:00Z", releases: [{ tag: "v1.0.0", name: "v1.0.0", date: "2026-08-20" }] });
      }
      if (url.endsWith("/releases-cn/v1.0.0.json")) {
        return jsonResponse({ tag: "v1.0.0", name: "v1.0.0", date: "2026-08-20", markdown: "### 新功能\n- **A** — B", sections: [] });
      }
      return jsonResponse({}, 404);
    }),
  );

  const bootstrap = await loadChangelogBootstrap("cn");
  assert.deepEqual(bootstrap.index, [{ tag: "v1.0.0", name: "v1.0.0", date: "2026-08-20" }]);
  assert.equal(bootstrap.initialRelease?.tag, "v1.0.0");
  assert.equal(bootstrap.initialRelease?.markdown, "### 新功能\n- **A** — B");
  assert.equal(bootstrap.fallbackReleases, null);
  assert.deepEqual(requestedUrls, ["https://dl.dbxio.com/changelog/index-cn.json", "https://dl.dbxio.com/changelog/releases-cn/v1.0.0.json"]);
});

test("bootstrap falls back to the full listing while index files are unpublished", async () => {
  const requestedUrls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith("/index-cn.json")) {
        return jsonResponse({}, 404);
      }
      if (url.endsWith("/releases-cn.json")) {
        return jsonResponse({
          updatedAt: "2026-08-26T00:00:00Z",
          releases: [
            { tag: "v1.0.0", name: "v1.0.0", date: "2026-08-20", sections: [] },
            { tag: "v0.9.0", name: "v0.9.0", date: "2026-08-01", sections: [] },
          ],
        });
      }
      return jsonResponse({}, 404);
    }),
  );

  const bootstrap = await loadChangelogBootstrap("cn");
  assert.deepEqual(bootstrap.index, [
    { tag: "v1.0.0", name: "v1.0.0", date: "2026-08-20" },
    { tag: "v0.9.0", name: "v0.9.0", date: "2026-08-01" },
  ]);
  assert.equal(bootstrap.initialRelease?.tag, "v1.0.0");
  assert.equal(bootstrap.fallbackReleases?.length, 2);
  assert.deepEqual(requestedUrls, ["https://dl.dbxio.com/changelog/index-cn.json", "https://dl.dbxio.com/changelog/releases-cn.json"]);
});
