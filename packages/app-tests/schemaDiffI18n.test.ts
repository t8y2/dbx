import { strict as assert } from "node:assert";
import { test } from "vitest";
import en from "../../apps/desktop/src/i18n/locales/en.ts";
import es from "../../apps/desktop/src/i18n/locales/es.ts";
import it from "../../apps/desktop/src/i18n/locales/it.ts";
import ja from "../../apps/desktop/src/i18n/locales/ja.ts";
import ptBR from "../../apps/desktop/src/i18n/locales/pt-BR.ts";
import zhCN from "../../apps/desktop/src/i18n/locales/zh-CN.ts";
import zhTW from "../../apps/desktop/src/i18n/locales/zh-TW.ts";

const locales = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  es,
  it,
  "pt-BR": ptBR,
};

const schemaDiffDdlPanelKeys = ["copied", "ddlCompare", "deployScript", "deployScriptAll", "selectObjectToCompare", "noDdlAvailable", "sourceDdl", "targetDdl", "deployScriptDesc", "copy", "execute", "noDeployScript", "deployScriptAllDesc", "executeAll", "noDeployScriptAll"];

test("schema diff DDL panel has translations for all visible labels", () => {
  for (const [localeName, messages] of Object.entries(locales)) {
    for (const key of schemaDiffDdlPanelKeys) {
      const value = (messages.diff as Record<string, unknown>)[key];
      assert.equal(typeof value, "string", `${localeName} is missing diff.${key}`);
      assert.notEqual(value, "", `${localeName} diff.${key} must not be empty`);
    }
  }
});
