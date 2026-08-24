import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tauri = readFileSync(new URL("../tauri.ts", import.meta.url), "utf8");
const http = readFileSync(new URL("../http.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../api.ts", import.meta.url), "utf8");
const driverStore = readFileSync(new URL("../../../components/config/DriverStoreDialog.vue", import.meta.url), "utf8");
const tauriRegistry = readFileSync(new URL("../../../../../../src-tauri/src/lib.rs", import.meta.url), "utf8");
const webRegistry = readFileSync(new URL("../../../../../../crates/dbx-web/src/main.rs", import.meta.url), "utf8");

function functionBody(source: string, operation: string): string {
  const start = source.indexOf(`export async function ${operation}(`);
  expect(start, `${operation} transport function`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

function sourceSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `source marker ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `source marker ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

function buttonTagByTestId(testId: string): string {
  const marker = `data-testid="${testId}"`;
  const markerIndex = driverStore.indexOf(marker);
  expect(markerIndex, marker).toBeGreaterThanOrEqual(0);
  const start = driverStore.lastIndexOf("<Button", markerIndex);
  const end = driverStore.indexOf(">", markerIndex);
  expect(start, `${testId} button start`).toBeGreaterThanOrEqual(0);
  expect(end, `${testId} button end`).toBeGreaterThan(markerIndex);
  return driverStore.slice(start, end + 1);
}

function buttonTagsForClick(handler: string): string[] {
  const marker = `@click="${handler}"`;
  const tags: string[] = [];
  let offset = 0;
  while (true) {
    const markerIndex = driverStore.indexOf(marker, offset);
    if (markerIndex === -1) break;
    const start = driverStore.lastIndexOf("<Button", markerIndex);
    const end = driverStore.indexOf(">", markerIndex);
    expect(start, `${handler} button start`).toBeGreaterThanOrEqual(0);
    expect(end, `${handler} button end`).toBeGreaterThan(markerIndex);
    tags.push(driverStore.slice(start, end + 1));
    offset = end + 1;
  }
  expect(tags.length, `${handler} button count`).toBeGreaterThan(0);
  return tags;
}

describe("offline Agent export transport contract", () => {
  it("routes preview and export through the Tauri desktop backend", () => {
    expect(functionBody(tauri, "previewAgentOfflineExport")).toContain('invoke("preview_agent_offline_export")');
    expect(functionBody(tauri, "exportAgentsOffline")).toContain('invoke("export_agents_offline", { path, driverKeys })');
    expect(tauriRegistry).toContain("commands::agents::preview_agent_offline_export,");
    expect(tauriRegistry).toContain("commands::agents::export_agents_offline,");
    expect(api).toContain('previewAgentOfflineExport = forward("previewAgentOfflineExport")');
    expect(api).toContain('exportAgentsOffline = forward("exportAgentsOffline")');
  });

  it("keeps the Web transport explicitly unsupported without adding HTTP routes", () => {
    for (const operation of ["previewAgentOfflineExport", "exportAgentsOffline"]) {
      const body = functionBody(http, operation);
      expect(body).toContain("only available in the desktop app");
      expect(body).not.toContain("post(");
      expect(body).not.toContain("fetch(");
    }
    expect(webRegistry).not.toContain("agent-offline-export");
    expect(webRegistry).not.toContain("preview_agent_offline_export");
    expect(webRegistry).not.toContain("export_agents_offline");
  });

  it("shows export only on Desktop while preserving offline import on Desktop and Web", () => {
    const exportButton = buttonTagByTestId("agent-offline-export-button");
    const importButton = buttonTagByTestId("agent-offline-import-button");
    expect(exportButton).toContain(`v-if="driverStoreTab === 'agent' && !isWeb"`);
    expect(importButton).toContain(`v-if="driverStoreTab === 'agent'"`);
    expect(importButton).not.toContain("!isWeb");
    expect(exportButton).toContain(':disabled="agentExportImportBlocked"');
    expect(importButton).toContain(':disabled="agentExportImportBlocked"');
    expect(driverStore.indexOf(exportButton)).toBeLessThan(driverStore.indexOf(importButton));
  });

  it("shares one busy contract across export, import, driver, and JRE package actions", () => {
    const busyContract = sourceSection(driverStore, "const agentPackageBusy", "\n\nasync function openOfflineExportDialog");
    for (const dependency of ["agentImportBusy.value", "offlineExportLoading.value", "offlineExporting.value", "uninstallingDriver.value", "uninstallingJre.value", "installing.value", "preparingUpgradeAll.value", "upgradingAll.value", "reinstallingJre.value", "queuedDriverInstalls.value"]) {
      expect(busyContract).toContain(dependency);
    }

    for (const handler of ["upgradeAll", "installDriver(driver.db_type)", "importDriverFile(driver)", "uninstallDriver(driver.db_type)", "reinstallJre(jre.key)", "uninstallJre(jre.key)"]) {
      for (const button of buttonTagsForClick(handler)) expect(button).toContain("agentPackageBusy");
    }

    expect(sourceSection(driverStore, "async function importOfflineZip", "\n\nasync function importDriverFile")).toContain("if (agentExportImportBlocked.value) return;");
  });

  it("uses the platform-specific ZIP save contract and keeps failed exports retryable", () => {
    const openDialog = sourceSection(driverStore, "async function openOfflineExportDialog", "\n\nasync function exportOfflinePackage");
    expect(openDialog).toContain("if (isWeb || agentExportImportBlocked.value) return;");
    expect(openDialog).toContain("offlineExportDialogOpen.value = true;");
    expect(openDialog.indexOf('offlineExportError.value = "";')).toBeLessThan(openDialog.indexOf("await api.previewAgentOfflineExport()"));

    const exportPackage = sourceSection(driverStore, "async function exportOfflinePackage", "\n\nfunction chooseWebOfflineZip");
    expect(exportPackage).toContain("runAgentOfflineExportAction({");
    expect(exportPackage).toContain("defaultPath: `dbx-agents-offline-${platform}.zip`");
    expect(exportPackage).toContain('filters: [{ name: "ZIP", extensions: ["zip"] }]');

    const success = sourceSection(exportPackage, "onSuccess:", "\n    onError:");
    const failure = exportPackage.slice(exportPackage.indexOf("onError:"));
    expect(success).toContain("offlineExportDialogOpen.value = false;");
    expect(failure).toContain('t("driverStore.offlineExportFailed"');
    expect(failure).not.toContain("offlineExportDialogOpen.value = false;");

    const dialog = sourceSection(driverStore, "<AgentOfflineExportDialog", " />");
    expect(dialog).toContain('v-model:open="offlineExportDialogOpen"');
    expect(dialog).toContain(':preview="offlineExportPreview"');
    expect(dialog).toContain(':loading="offlineExportLoading"');
    expect(dialog).toContain(':exporting="offlineExporting"');
    expect(dialog).toContain(':error="offlineExportError"');
    expect(dialog).toContain('@confirm="exportOfflinePackage"');
  });
});
