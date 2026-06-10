import { strict as assert } from "node:assert";
import { test } from "vitest";
import { getTauriThemeForMode, normalizeAppThemeMode, resolveAppThemeAppearance } from "../../apps/desktop/src/lib/appTheme.ts";

test("normalizes stored app theme modes", () => {
  assert.equal(normalizeAppThemeMode("dark"), "dark");
  assert.equal(normalizeAppThemeMode("light"), "light");
  assert.equal(normalizeAppThemeMode("system"), "system");
  assert.equal(normalizeAppThemeMode(null), "light");
  assert.equal(normalizeAppThemeMode("unexpected"), "light");
});

test("resolves system app theme from current system preference", () => {
  assert.equal(resolveAppThemeAppearance("light", true), "light");
  assert.equal(resolveAppThemeAppearance("dark", false), "dark");
  assert.equal(resolveAppThemeAppearance("system", true), "dark");
  assert.equal(resolveAppThemeAppearance("system", false), "light");
});

test("maps system app theme mode to native automatic theme", () => {
  assert.equal(getTauriThemeForMode("light"), "light");
  assert.equal(getTauriThemeForMode("dark"), "dark");
  assert.equal(getTauriThemeForMode("system"), null);
});
