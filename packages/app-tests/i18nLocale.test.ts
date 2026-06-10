import { strict as assert } from "node:assert";
import { test } from "vitest";
import { detectLocaleFromLanguages, localeFromLanguageTag, normalizeLocale } from "../../apps/desktop/src/i18n/index.ts";

test("normalizes exact supported locales", () => {
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("es"), "es");
  assert.equal(normalizeLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeLocale("zh-TW"), "zh-TW");
  assert.equal(normalizeLocale("fr-FR"), null);
  assert.equal(normalizeLocale(null), null);
});

test("maps user language tags to supported locales", () => {
  assert.equal(localeFromLanguageTag("zh-Hans-CN"), "zh-CN");
  assert.equal(localeFromLanguageTag("zh_TW"), "zh-TW");
  assert.equal(localeFromLanguageTag("zh-Hant-HK"), "zh-TW");
  assert.equal(localeFromLanguageTag("en-US"), "en");
  assert.equal(localeFromLanguageTag("es-MX"), "es");
  assert.equal(localeFromLanguageTag("fr-FR"), null);
});

test("detects the first supported user locale and falls back to Chinese", () => {
  assert.equal(detectLocaleFromLanguages(["fr-FR", "es-MX", "en-US"]), "es");
  assert.equal(detectLocaleFromLanguages(["de-DE", "ja-JP"]), "zh-CN");
  assert.equal(detectLocaleFromLanguages([]), "zh-CN");
});
