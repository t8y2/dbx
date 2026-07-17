import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

const syncChangelog = await importScript(".github/scripts/sync-changelog.mjs");

function importScript(path: string): Promise<Record<string, unknown>> {
  const source = readFileSync(resolve(path), "utf8")
    .replace(/^#!.*\r?\n/, "")
    .replace("if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))", "if (false)");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

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

test("translateToEnglish falls back to cached translations when API key is missing", async () => {
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
  const cachedEnJson = { updatedAt: "2026-05-17T01:00:00.000Z", releases: [cachedRelease] };

  let translationCalls = 0;
  const enJson = await syncChangelog.translateToEnglish(cnJson, {
    cachedEnJson,
    deepseekApiKey: "",
    fetchImpl: async () => {
      translationCalls++;
      return { ok: true, json: async () => ({}) };
    },
    sleep: async () => {},
  });

  // 无 key 时不调用翻译 API
  assert.equal(translationCalls, 0);
  // cache 命中的条目复用英文翻译
  assert.deepEqual(enJson.releases[1], cachedRelease);
  // cache 未命中的条目回退中文原文，保证 CHANGELOG 条目不缺失
  assert.equal(enJson.releases[0].sections[0].title, "新功能");
});

test("parseBody strips closes # issue refs but keeps contributor attribution", () => {
  const sections = syncChangelog.parseBody(
    "### 新功能\n- **导出** — 支持导出表数据 (contributed by @wuxiemian, closes #2577, closes #2473)\n- **清理** — 删除旧资源 (closes #2586)\n- **校验** — 预校验路径 (closes #88, contributed by @Mukesh)",
  );
  assert.equal(sections[0].items[0].desc, "支持导出表数据 (contributed by @wuxiemian)");
  assert.equal(sections[0].items[1].desc, "删除旧资源");
  assert.equal(sections[0].items[2].desc, "预校验路径 (contributed by @Mukesh)");
});
