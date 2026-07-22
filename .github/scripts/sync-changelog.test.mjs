import assert from "node:assert/strict";
import test from "node:test";

import { buildLatestReleaseNotes } from "./sync-changelog.mjs";

test("buildLatestReleaseNotes returns the curated latest release body", () => {
  const result = buildLatestReleaseNotes([
    {
      tag_name: "v0.5.62",
      draft: false,
      prerelease: false,
      published_at: "2026-07-20T00:00:00Z",
      body: "### 新功能\n- old\n\n### 下载安装\n- assets",
    },
    {
      tag_name: "v0.5.63",
      draft: false,
      prerelease: false,
      published_at: "2026-07-21T00:00:00Z",
      body: "### 新功能\n- new\n\n### 下载安装\n- assets",
    },
  ]);

  assert.deepEqual(result, {
    version: "v0.5.63",
    notes: "### 新功能\n- new\n\n### 下载安装\n- assets",
  });
});
