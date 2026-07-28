import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { fetchChangelog } from "./changelog";
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
