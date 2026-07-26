import assert from "node:assert/strict";
import test from "node:test";

import { buildLatestReleaseNotes, buildReleasesJson } from "./sync-changelog.mjs";

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

test("changelog excludes agent and package release streams", () => {
  const releases = [
    {
      tag_name: "packages-v0.4.42",
      draft: false,
      prerelease: false,
      published_at: "2026-07-23T02:00:00Z",
      body: "### Changed\n- packages",
    },
    {
      tag_name: "agents-v0.2.64",
      draft: false,
      prerelease: false,
      published_at: "2026-07-23T01:00:00Z",
      body: "### Changed\n- agents",
    },
    {
      tag_name: "v0.5.66",
      draft: false,
      prerelease: false,
      published_at: "2026-07-23T00:00:00Z",
      body: "### Changed\n- app",
    },
  ];

  assert.deepEqual(
    buildReleasesJson(releases, new Date("2026-07-24T00:00:00Z")).releases.map((release) => release.tag),
    ["v0.5.66"],
  );
  assert.deepEqual(buildLatestReleaseNotes(releases), {
    version: "v0.5.66",
    notes: "### Changed\n- app",
  });
});
