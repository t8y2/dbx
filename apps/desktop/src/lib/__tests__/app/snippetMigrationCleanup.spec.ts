import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");
const httpBackendSource = readFileSync(new URL("../../backend/http.ts", import.meta.url), "utf8");
const tauriBackendSource = readFileSync(new URL("../../backend/tauri.ts", import.meta.url), "utf8");

describe("snippet migration cleanup recovery", () => {
  it("restores pending cleanup state and keeps it visible after restart", () => {
    expect(settingsDialogSource).toContain('pendingLegacyCleanupId.value = settings.legacyCleanupRequiredId || ""');
    expect(settingsDialogSource).toContain('v-if="pendingLegacyCleanupId"');
    expect(settingsDialogSource).toContain('t("settings.syncSnippetMigrateLegacyCleanupRequired", { id: pendingLegacyCleanupId })');
  });

  it("clears the UI state only after the retry response confirms cleanup", () => {
    const retryStart = settingsDialogSource.indexOf("async function retryLegacySnippetCleanup()");
    const retryEnd = settingsDialogSource.indexOf("async function downloadSnippetSnapshot()", retryStart);
    const retrySource = settingsDialogSource.slice(retryStart, retryEnd);
    expect(retrySource).toContain("await retrySnippetLegacyCleanup(currentSnippetConfig())");
    expect(retrySource).toContain('pendingLegacyCleanupId.value = settings.legacyCleanupRequiredId || ""');
    expect(retrySource).toContain("if (settings.legacyCleanupRequiredId)");
  });

  it("wires the retry operation through both Web and Tauri backends", () => {
    expect(httpBackendSource).toContain('post("/api/cloud-sync/snippet/retry-legacy-cleanup", { config })');
    expect(tauriBackendSource).toContain('invoke("retry_snippet_legacy_cleanup", { config })');
    expect(httpBackendSource).toContain("legacyCleanupRequiredId?: string");
    expect(tauriBackendSource).toContain("legacyCleanupRequiredId?: string");
  });
});
