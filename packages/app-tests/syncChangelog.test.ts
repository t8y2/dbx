import { strict as assert } from "node:assert";
import { test } from "vitest";

const syncChangelog = await import("../../.github/scripts/sync-changelog.mjs");

test("translateToEnglish reuses cached release translations when source hash is unchanged", async () => {
  const cnJson = syncChangelog.buildReleasesJson(
    [
      {
        tag_name: "v1.1.0",
        name: "DBX v1.1.0",
        published_at: "2026-05-18T00:00:00Z",
        body: "### 新功能\n- **新增导出** — 支持导出表数据",
        draft: false,
        prerelease: false,
      },
      {
        tag_name: "v1.0.0",
        name: "DBX v1.0.0",
        published_at: "2026-05-17T00:00:00Z",
        body: "### 修复\n- **修复连接** — 避免重复连接",
        draft: false,
        prerelease: false,
      },
    ],
    new Date("2026-05-18T01:00:00Z"),
  );
  const cachedRelease = {
    ...cnJson.releases[1],
    sections: [{ type: "fixed", title: "Fixed", items: [{ title: "Connection fix", desc: "Avoid duplicate connects" }] }],
  };
  const cachedEnJson = {
    updatedAt: "2026-05-17T01:00:00.000Z",
    releases: [cachedRelease],
  };
  let translationCalls = 0;

  const enJson = await syncChangelog.translateToEnglish(cnJson, {
    cachedEnJson,
    deepseekApiKey: "test-key",
    fetchImpl: async () => {
      translationCalls++;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "### Added\n- **Export added** — Supports table data export" } }],
        }),
      };
    },
    sleep: async () => {},
  });

  assert.equal(translationCalls, 1);
  assert.deepEqual(enJson.releases[1], cachedRelease);
  assert.equal(enJson.releases[0].sections[0].title, "Added");
  assert.equal(enJson.releases[0]._sourceHash, cnJson.releases[0]._sourceHash);
});
