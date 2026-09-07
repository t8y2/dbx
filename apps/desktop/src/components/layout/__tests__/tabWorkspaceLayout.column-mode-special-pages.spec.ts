import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const tabBarSource = readFileSync(new URL("../AppTabBar.vue", import.meta.url), "utf8");

// Special pages use the global tab-bar portal so their navigation remains
// separate from the editor groups in every tab-placement mode.
describe("special-page workspace portal layout", () => {
  it("provides the portal from App and renders the special-page workspace", () => {
    expect(appSource).toContain("provide(GROUP_TAB_BAR_PORTAL");
    expect(tabBarSource).toContain('v-show="driverStoreActive || settingsPageActive"');
    expect(tabBarSource).toContain("data-special-page-workspace");
  });

  it("keeps the special-page navigation and content panes independently sized", () => {
    expect(tabBarSource).toContain("data-special-page-navigation");
    expect(tabBarSource).toContain("data-special-page-content");
    expect(tabBarSource).toContain(':class="layoutClass"');
    expect(tabBarSource).toContain("flex-1 flex-col overflow-hidden");
  });
});
