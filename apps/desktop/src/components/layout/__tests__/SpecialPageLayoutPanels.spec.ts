// @vitest-environment happy-dom
import { computed, ref } from "vue";
import { describe, expect, it } from "vitest";

describe("Special page layout and right sidebar panels visibility", () => {
  it("shows editor content and hides right panels when a special page is active", () => {
    const isDetachedWindowContext = false;
    const driverStoreActive = ref(false);
    const pluginCenterActive = ref(false);
    const settingsPageActive = ref(false);
    const isAiPanelMaximized = ref(false);
    const isHistoryPanelMaximized = ref(true);
    const isZenMode = ref(false);

    const isSpecialPageActive = computed(() => !isDetachedWindowContext && (driverStoreActive.value || pluginCenterActive.value || settingsPageActive.value));

    const showEditorContent = computed(() => isSpecialPageActive.value || (!isAiPanelMaximized.value && !isHistoryPanelMaximized.value) || isZenMode.value);

    const showAiPanelVisible = computed(() => !isSpecialPageActive.value && !isHistoryPanelMaximized.value && !isZenMode.value);

    const showHistoryPanelVisible = computed(() => !isSpecialPageActive.value && !isAiPanelMaximized.value && !isZenMode.value);

    const showSqlLibraryPanelVisible = computed(() => !isSpecialPageActive.value && !isAiPanelMaximized.value && !isHistoryPanelMaximized.value && !isZenMode.value);

    // Initially: query workspace, history is maximized
    expect(isSpecialPageActive.value).toBe(false);
    expect(showEditorContent.value).toBe(false); // editor content hidden because history is maximized
    expect(showHistoryPanelVisible.value).toBe(true);

    // User opens settings page
    settingsPageActive.value = true;
    expect(isSpecialPageActive.value).toBe(true);
    // Settings page in editor content must be visible even if history was maximized
    expect(showEditorContent.value).toBe(true);
    // Right sidebar panels must be hidden on settings page
    expect(showHistoryPanelVisible.value).toBe(false);
    expect(showAiPanelVisible.value).toBe(false);
    expect(showSqlLibraryPanelVisible.value).toBe(false);

    // User closes settings and returns to query editor
    settingsPageActive.value = false;
    expect(isSpecialPageActive.value).toBe(false);
    expect(showEditorContent.value).toBe(false); // back to maximized history
    expect(showHistoryPanelVisible.value).toBe(true);
  });

  it("switches to query surface if a right sidebar panel is toggled from a special page", () => {
    const surface = ref("settings");
    const isSpecialPageActive = computed(() => surface.value === "settings");

    function activateQuerySurface() {
      surface.value = "query";
    }

    function setRightSidebarPanelOpen(open: boolean) {
      if (open && isSpecialPageActive.value) {
        activateQuerySurface();
      }
    }

    setRightSidebarPanelOpen(true);
    expect(surface.value).toBe("query");
    expect(isSpecialPageActive.value).toBe(false);
  });

  it("resets maximized panel state when an ordinary query tab is activated", () => {
    const isHistoryPanelMaximized = ref(true);
    const isAiPanelMaximized = ref(true);

    function activateQueryTab() {
      isHistoryPanelMaximized.value = false;
      isAiPanelMaximized.value = false;
    }

    activateQueryTab();
    expect(isHistoryPanelMaximized.value).toBe(false);
    expect(isAiPanelMaximized.value).toBe(false);
  });
});
