import { strict as assert } from "node:assert";
import { test } from "vitest";
import en from "../../apps/desktop/src/i18n/locales/en.ts";
import es from "../../apps/desktop/src/i18n/locales/es.ts";
import it from "../../apps/desktop/src/i18n/locales/it.ts";
import ja from "../../apps/desktop/src/i18n/locales/ja.ts";
import ko from "../../apps/desktop/src/i18n/locales/ko.ts";
import ptBR from "../../apps/desktop/src/i18n/locales/pt-BR.ts";
import zhCN from "../../apps/desktop/src/i18n/locales/zh-CN.ts";
import zhTW from "../../apps/desktop/src/i18n/locales/zh-TW.ts";

test("every locale defines the PostgreSQL legacy TLS labels", () => {
  const locales = { en, es, it, ja, ko, ptBR, zhCN, zhTW } as const;

  for (const [localeName, locale] of Object.entries(locales)) {
    assert.ok(locale.connection.postgresLegacyTls.length > 0, `${localeName}: connection.postgresLegacyTls`);
    assert.ok(locale.connection.postgresLegacyTlsHint.length > 0, `${localeName}: connection.postgresLegacyTlsHint`);
  }
});
