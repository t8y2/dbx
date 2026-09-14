import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { english, localizeManifest, translate } from "../ui/i18n.js";

test("shell labels and diagnostics translate without altering arbitrary business data", async () => {
  for (const file of ["App.vue", "DebugPanel.vue"]) {
    const source = await readFile(new URL(`../ui/${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\bt\('([^']+)'/g)) {
      assert.ok(english[match[1]], `Missing English label: ${match[1]}`);
    }
  }
  assert.equal(translate("en", "RPC 完成"), "RPC completed");
  assert.equal(translate("zh-CN", "RPC 完成"), "RPC 完成");
  assert.equal(translate("en", "自定义连接"), "自定义连接");
  assert.match(translate("en", "删除连接“{name}”？其页面将关闭，未保存修改会丢失。", { name: "My DB" }), /My DB/);
});

test("manifest localization switches from original labels and preserves defaults", () => {
  const source = {
    name: "Example",
    contributions: [{ id: "main", label: "Page", fields: [{ key: "mode", label: "Mode", default: "one", options: [{ value: "one", label: "One" }] }] }],
    localizations: { "zh-CN": { name: "示例", contributions: { main: { label: "页面", fields: { mode: { label: "模式", options: { one: "一" } } } } } } },
  };
  const chinese = localizeManifest(source, "zh-CN");
  assert.equal(chinese.name, "示例");
  assert.equal(chinese.contributions[0].fields[0].options[0].label, "一");
  assert.equal(chinese.contributions[0].fields[0].default, "one");
  assert.equal(localizeManifest(source, "en").contributions[0].label, "Page");
  assert.equal(source.name, "Example");
});
