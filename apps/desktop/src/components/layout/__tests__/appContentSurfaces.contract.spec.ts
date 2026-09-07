import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

// The editor-content wrapper carries a v-show guard that hides it while the
// settings page or driver store is the active surface. A past merge resolved
// this region by nesting the special surfaces INSIDE that guarded wrapper,
// which display:none-d the settings page exactly when it was active. These
// assertions pin the sibling order so a future merge cannot re-introduce it.
describe("App main content surface structure", () => {
  it("hides only the editor workspace via the surface guard, never the special pages", () => {
    const guard = 'v-show="!driverStoreActive && !settingsStore.settingsPageActive"';
    // The empty-state slot shares the query surface's visibility guard.
    expect(appSource.split(guard).length - 1).toBe(1);

    // Source order: special surfaces first, then the guarded editor wrapper.
    const markers = ["<DriverStorePage", "<EditorSettingsPage", guard, "<SqlEditorWorkspace", "<WelcomeScreen"];
    const indices = markers.map((marker) => appSource.indexOf(marker));
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it("keeps navigation independent from the workspace welcome content", () => {
    expect(appSource).toContain(':show-tab-navigation="queryStore.tabs.length > 0 || settingsPageTabOpen || driverStoreTabOpen"');
    expect(appSource).toContain(':active-tab="activeTab ?? undefined"');
    expect(appSource).toMatch(/<template #empty>\s*<WelcomeScreen/);
    expect(appSource).not.toContain('v-if="queryStore.tabs.length > 0 || settingsPageTabOpen || driverStoreTabOpen"');
  });

  it("anchors the drag-back hit test on every pane strip and the special-surfaces bar", () => {
    const groupBarSource = readFileSync(new URL("../EditorGroupTabBar.vue", import.meta.url), "utf8");
    const slimBarSource = readFileSync(new URL("../AppTabBar.vue", import.meta.url), "utf8");
    expect(groupBarSource).toContain("data-main-tab-bar");
    expect(groupBarSource).toContain("'ring-2 ring-primary ring-inset': detachedDropTarget");
    expect(slimBarSource).toContain("data-special-page-tab-target");
    expect(slimBarSource).not.toContain("data-return-tab");
    // The split workspace renders several bars; the hit test must union their rects.
    expect(appSource).toContain('querySelectorAll<HTMLElement>("[data-main-tab-bar]")');
  });
});
