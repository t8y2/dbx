import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");
const tauriBackendSource = readFileSync(new URL("../../../lib/backend/tauri.ts", import.meta.url), "utf8");
const httpBackendSource = readFileSync(new URL("../../../lib/backend/http.ts", import.meta.url), "utf8");

describe("MCP server management", () => {
  it("makes native installation the default while preserving npm as a migration fallback", () => {
    expect(settingsDialogSource).toContain('mcpStatus.value?.installation_source === "npm"');
    expect(settingsDialogSource).toContain('t("settings.mcpSwitchToNativeButton")');
    expect(settingsDialogSource).toContain('t("settings.mcpNativeMigrationHint")');
    expect(settingsDialogSource).toContain("await installNativeMcpServer()");
    expect(settingsDialogSource).toContain("await uninstallNpmMcpServer()");
    expect(settingsDialogSource).toContain("mcpStatus?.installation_source !== 'npm' && mcpStatus?.npm_installed");
    expect(settingsDialogSource).toContain(':disabled="mcpInstallDisabled"');
    expect(settingsDialogSource).not.toContain("!mcpStatus?.npm_available");
    expect(tauriBackendSource).toContain('installation_source: "native" | "homebrew" | "npm" | null');
    expect(tauriBackendSource).toContain('invoke("install_native_mcp_server")');
    expect(tauriBackendSource).toContain('invoke("uninstall_npm_mcp_server")');
  });

  it("exposes a confirmed uninstall action only for an installed desktop server", () => {
    expect(settingsDialogSource).toContain('v-if="!isWeb && mcpStatus?.installed"');
    expect(settingsDialogSource).toContain('window.confirm(t("settings.mcpUninstallConfirm"))');
    expect(settingsDialogSource).toContain("await uninstallMcpServer()");
    expect(settingsDialogSource).toContain('t("settings.mcpUninstallCommand")');
    expect(settingsDialogSource).toContain("copyMcpText('uninstall', mcpUninstallCommand)");
    expect(tauriBackendSource).toContain('invoke("uninstall_mcp_server")');
    expect(httpBackendSource).toContain("MCP Server uninstallation is only available in the desktop app.");
  });
});
