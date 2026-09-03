import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

describe("settings page navigation", () => {
  it("keeps query, settings, and driver-manager surfaces mutually exclusive", () => {
    expect(appSource).toContain('type MainContentSurface = "query" | "settings" | "driverStore";');
    expect(appSource).toMatch(/function activateMainContentSurface\(surface: MainContentSurface\) \{\s*settingsStore\.settingsPageActive = surface === "settings";\s*driverStoreActive\.value = surface === "driverStore";/);
    expect(appSource).toMatch(/function activateSettingsPage\(\) \{\s*settingsPageTabOpen\.value = true;\s*activateMainContentSurface\("settings"\);/);
    expect(appSource).toMatch(/function activateQuerySurface\(\) \{\s*activateMainContentSurface\("query"\);/);
    expect(appSource).toMatch(/driverStoreTabOpen\.value = true;\s*activateMainContentSurface\("driverStore"\);/);
  });

  it("replays repeated navigation requests for the same tab", () => {
    expect(appSource).toContain("settingsNavigationRequestId.value += 1");
    expect(appSource).toContain(':navigation-request-id="settingsNavigationRequestId"');
    expect(settingsDialogSource).toContain("navigationRequestId?: number;");
    expect(settingsDialogSource).toMatch(/watch\(\s*\(\) => props\.navigationRequestId,/);
  });

  it("routes AI configuration drafts into the unsaved new-config form", () => {
    const handlerStart = settingsDialogSource.indexOf("async function applyPendingAiConfigDeepLinkDraft()");
    const handlerEnd = settingsDialogSource.indexOf("async function aiSaveConfig()", handlerStart);
    const handlerSource = settingsDialogSource.slice(handlerStart, handlerEnd);

    expect(appSource).toContain('openSettings("ai")');
    expect(appSource).toContain(':ai-config-draft="settingsAiConfigDraft"');
    expect(appSource).toContain(':ai-config-request-id="settingsAiConfigRequestId"');
    expect(settingsDialogSource).toContain("aiEnterEditMode();");
    expect(handlerSource).toContain("aiEditProviderPresetId.value = getAiProviderPresetId(draft.provider, draft.endpoint);");
    expect(settingsDialogSource).toContain('aiEditApiKey.value = "";');
    expect(settingsDialogSource).toContain("importClipboardApiKeyAfterConfirmation");
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handlerSource).not.toContain("aiSaveConfig(");
    expect(handlerSource).not.toContain("aiTestConn(");
  });
});
