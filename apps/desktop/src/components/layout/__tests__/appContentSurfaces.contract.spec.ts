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
    // One guarded wrapper; the welcome screen's v-else-if reuses the flags in
    // its own condition and must not be mistaken for a second guard.
    expect(appSource.split(guard).length - 1).toBe(1);

    // Source order: special surfaces first, then the guarded editor wrapper.
    const markers = ["<DriverStorePage", "<EditorSettingsPage", guard, "<SqlEditorWorkspace", "<WelcomeScreen"];
    const indices = markers.map((marker) => appSource.indexOf(marker));
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it("guards the editor wrapper with the open-tab count and chains the welcome screen to it", () => {
    expect(appSource).toContain('<div v-if="queryStore.tabs.length > 0" v-show="!driverStoreActive && !settingsStore.settingsPageActive"');
    expect(appSource).toContain('v-else-if="queryStore.tabs.length === 0 && !driverStoreActive && !settingsStore.settingsPageActive"');
  });

  it("anchors the drag-back hit test on every pane strip and the special-surfaces bar", () => {
    const groupBarSource = readFileSync(new URL("../EditorGroupTabBar.vue", import.meta.url), "utf8");
    const slimBarSource = readFileSync(new URL("../AppTabBar.vue", import.meta.url), "utf8");
    expect(groupBarSource).toContain("data-main-tab-bar");
    expect(groupBarSource).toContain("'ring-2 ring-primary ring-inset': detachedDropTarget");
    expect(slimBarSource).toContain("data-main-tab-bar");
    expect(slimBarSource).toContain("'ring-2 ring-primary ring-inset': detachedDropTarget");
    // The split workspace renders several bars; the hit test must union their rects.
    expect(appSource).toContain('querySelectorAll<HTMLElement>("[data-main-tab-bar]")');
  });
});
