import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { buildMetadata, DEFAULT_OG_IMAGE } from "./metadata";

test("metadata normalizes canonicals and uses matching BCP 47 alternates", () => {
  const metadata = buildMetadata({ title: "文档", description: "说明", path: "/cn/docs/?ref=test#intro", lang: "cn", markdownPath: "/cn/markdown/index.md" });
  assert.equal(metadata.alternates?.canonical, "https://dbxio.com/cn/docs");
  assert.deepEqual(metadata.alternates?.languages, { en: "https://dbxio.com/en/docs", "zh-CN": "https://dbxio.com/cn/docs", "x-default": "https://dbxio.com/en/docs" });
  assert.deepEqual(metadata.alternates?.types, { "text/markdown": "https://dbxio.com/cn/markdown/index.md" });
  assert.equal(metadata.openGraph?.url, metadata.alternates?.canonical);
});

test("locale replacement respects complete route segments", () => {
  const metadata = buildMetadata({ title: "English", description: "Description", path: "/english", lang: "en" });
  assert.equal(metadata.alternates?.languages?.["zh-CN"], "https://dbxio.com/english");
});

test("default social cards reuse the same artwork as both README headers", () => {
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const readme = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.equal(readme.match(/<img\s+src="([^"]+)"/)?.[1], DEFAULT_OG_IMAGE);
  }

  const metadata = buildMetadata({ title: "DBX", description: "Database client", path: "/en", lang: "en" });
  assert.deepEqual(metadata.openGraph?.images, [{ url: DEFAULT_OG_IMAGE, width: 1792, height: 896 }]);
  assert.deepEqual(metadata.twitter?.images, [DEFAULT_OG_IMAGE]);
});
