import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const tabBarSource = readFileSync(new URL("../AppTabBar.vue", import.meta.url), "utf8");

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

// Regression test for #8213: AppTabBar's settings/driver special-page strip is
// still a horizontal-only "w-full" bar. Placing it inside a flex-row /
// flex-row-reverse workspace (left/right column tab placement) squeezes the
// sibling content pane (EditorSettingsPage/DriverStorePage) to zero width,
// making the settings/driver page invisible after it's reopened. The fix
// falls back to a flex-col workspace while either special page is active.
describe("tabWorkspaceLayoutClass column-mode special-page fallback", () => {
  const computedBlock = sourceBetween(appSource, "const tabWorkspaceLayoutClass = computed(() => {", "});");

  it("falls back to flex-col while the settings/driver strip is active, before the vertical branch", () => {
    const specialPageGuardIndex = computedBlock.indexOf("isSpecialPageStripActive.value");
    const verticalRowIndex = computedBlock.indexOf('isVerticalTabPlacement.value ? "flex-row" : "flex-col"');
    expect(specialPageGuardIndex).toBeGreaterThanOrEqual(0);
    expect(verticalRowIndex).toBeGreaterThan(specialPageGuardIndex);
    expect(computedBlock).toMatch(/isVerticalTabPlacement\.value\s*&&\s*isSpecialPageStripActive\.value\)\s*return\s*"flex-col"/);
  });

  it("derives isSpecialPageStripActive from the same flags AppTabBar uses to render", () => {
    expect(appSource).toContain("const isSpecialPageStripActive = computed(() => driverStoreActive.value || settingsStore.settingsPageActive);");
    // AppTabBar itself only renders while one of these is true - keep the guard in sync with it.
    expect(tabBarSource).toContain('v-if="driverStoreActive || settingsPageActive"');
  });

  it("still stretches the special-page strip full width (the part the flex-col fallback protects against)", () => {
    expect(tabBarSource).toMatch(/class="app-tab-bar[^"]*\bw-full\b/);
  });
});
