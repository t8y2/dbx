import assert from "node:assert/strict";
import { test } from "vitest";

import { buildSiteStructuredData, buildSoftwareApplicationStructuredData } from "./structuredData";

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
  assert.match(english.description, /70\+ databases/);
  assert.equal(chinese.inLanguage, "zh-CN");
  assert.match(chinese.description, /70\+ 种数据库/);
  assert.equal(chinese.license, "https://github.com/t8y2/dbx/blob/main/LICENSE");
});
