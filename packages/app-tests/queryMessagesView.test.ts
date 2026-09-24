import assert from "node:assert/strict";
import { test } from "vitest";
import az from "../../apps/desktop/src/i18n/locales/az.ts";
import en from "../../apps/desktop/src/i18n/locales/en.ts";
import es from "../../apps/desktop/src/i18n/locales/es.ts";
import it from "../../apps/desktop/src/i18n/locales/it.ts";
import ja from "../../apps/desktop/src/i18n/locales/ja.ts";
import ko from "../../apps/desktop/src/i18n/locales/ko.ts";
import tr from "../../apps/desktop/src/i18n/locales/tr.ts";
import ptBR from "../../apps/desktop/src/i18n/locales/pt-BR.ts";
import zhCN from "../../apps/desktop/src/i18n/locales/zh-CN.ts";
import zhTW from "../../apps/desktop/src/i18n/locales/zh-TW.ts";

test("every locale defines the query message strings", () => {
  const locales = { az, en, es, it, ja, ko, "pt-BR": ptBR, tr, "zh-CN": zhCN, "zh-TW": zhTW };

  for (const [name, locale] of Object.entries(locales)) {
    assert.ok(locale.queryMessages.empty.length > 0, `${name}: queryMessages.empty`);
    assert.ok(locale.queryMessages.code.includes("{code}"), `${name}: queryMessages.code keeps the {code} placeholder`);
    assert.ok(locale.tabs.messages.length > 0, `${name}: tabs.messages`);
  }
});
