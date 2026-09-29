import assert from "node:assert/strict";
import { test } from "vitest";

import { buildDocStructuredData, buildSiteStructuredData, buildSoftwareApplicationStructuredData, serializeStructuredData } from "./structuredData";

test("site structured data does not advertise a nonexistent search route", () => {
  const [website, organization] = buildSiteStructuredData();

  assert.equal(website["@type"], "WebSite");
  assert.equal("potentialAction" in website, false);
  assert.equal(organization["@id"], "https://dbxio.com/#organization");
});

test("software structured data stays localized and versioned", () => {
  const english = buildSoftwareApplicationStructuredData("en", "0.5.71");
  const chinese = buildSoftwareApplicationStructuredData("cn", "0.5.71");

  assert.equal(english.applicationCategory, "DeveloperApplication");
  assert.equal(english.softwareVersion, "0.5.71");
  assert.equal(english.inLanguage, "en");
  assert.match(english.description, /100\+ data systems/);
  assert.equal(chinese.inLanguage, "zh-CN");
  assert.match(chinese.description, /100\+ 种数据系统/);
  assert.equal(chinese.license, "https://github.com/t8y2/dbx/blob/main/LICENSE");
});

test("documentation breadcrumbs use localized titles and real documentation roots", () => {
  const [breadcrumb, article] = buildDocStructuredData("cn", "快速开始", "连接数据库", "/cn/docs/getting-started");
  assert.equal(breadcrumb.itemListElement?.[0].name, "首页");
  assert.equal(breadcrumb.itemListElement?.[1].item, "https://dbxio.com/cn/docs/what-is-dbx");
  assert.equal(breadcrumb.itemListElement?.[2].name, "快速开始");
  assert.equal(article.mainEntityOfPage, "https://dbxio.com/cn/docs/getting-started");
  assert.equal(buildDocStructuredData("en", "Docs", "Documentation", "/en/docs/what-is-dbx")[0].itemListElement?.length, 2);
});

test("JSON-LD cannot break out of its script element", () => {
  const value = { headline: '</script><script>alert("injected")</script>' };
  const serialized = serializeStructuredData(value);
  assert.equal(serialized.includes("<"), false);
  assert.deepEqual(JSON.parse(serialized), value);
});
