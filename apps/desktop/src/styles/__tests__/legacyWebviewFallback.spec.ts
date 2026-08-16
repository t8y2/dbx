import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCascadeCss } from "./cascadeCss";

const globalsCss = readCascadeCss();
const dialogContentSource = readFileSync(new URL("../../components/ui/dialog/DialogContent.vue", import.meta.url), "utf8");
const dialogScrollContentSource = readFileSync(new URL("../../components/ui/dialog/DialogScrollContent.vue", import.meta.url), "utf8");
const dialogOverlaySource = readFileSync(new URL("../../components/ui/dialog/DialogOverlay.vue", import.meta.url), "utf8");
const connectionDialogSource = readFileSync(new URL("../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const connectionTreeSource = readFileSync(new URL("../../components/sidebar/ConnectionTree.vue", import.meta.url), "utf8");
const scheduledDatabaseBackupSource = readFileSync(new URL("../../components/backup/ScheduledDatabaseBackupSettings.vue", import.meta.url), "utf8");
const driverStoreDialogSource = readFileSync(new URL("../../components/config/DriverStoreDialog.vue", import.meta.url), "utf8");
const tunnelProfileManagerSource = readFileSync(new URL("../../components/connection/TunnelProfileManager.vue", import.meta.url), "utf8");
const changelogPanelSource = readFileSync(new URL("../../components/settings/ChangelogPanel.vue", import.meta.url), "utf8");
const editorSettingsDialogSource = readFileSync(new URL("../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");
const switchSource = readFileSync(new URL("../../components/ui/switch/Switch.vue", import.meta.url), "utf8");
const desktopIndexSource = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
const connectionDialogLegacyCss = readFileSync(new URL("../../../public/connection-dialog-legacy.css", import.meta.url), "utf8");
const legacyWebViewSource = readFileSync(new URL("../../lib/ui/legacyWebView.ts", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");

describe("legacy WebView CSS fallbacks", () => {
  it("scopes component overrides to the runtime legacy WebView class", () => {
    const fallbackStart = globalsCss.indexOf("html.dbx-legacy-webview .sm\\:block");
    const tabsOverride = globalsCss.indexOf('html.dbx-legacy-webview [data-slot="tabs-trigger"]');
    const splitpanesStart = globalsCss.indexOf("/* Splitpanes */");

    expect(fallbackStart).toBeGreaterThan(-1);
    expect(tabsOverride).toBeGreaterThan(fallbackStart);
    expect(splitpanesStart).toBeGreaterThan(tabsOverride);
    expect(globalsCss.slice(fallbackStart, splitpanesStart)).toContain('html.dbx-legacy-webview [data-slot="tabs-trigger"]');
  });

  it("falls back to the legacy viewport height when dynamic viewport units are unavailable", () => {
    const fallback = globalsCss.indexOf("--dbx-viewport-height: 100vh;");
    const supports = globalsCss.indexOf("@supports (height: 100dvh)");
    const enhanced = globalsCss.indexOf("--dbx-viewport-height: min(100vh, 100dvh);");

    expect(fallback).toBeGreaterThan(-1);
    expect(supports).toBeGreaterThan(fallback);
    expect(enhanced).toBeGreaterThan(supports);
    expect(dialogContentSource).toContain("max-h-[calc(var(--dbx-viewport-height)-2rem)]");
    expect(dialogScrollContentSource).toContain("max-h-[calc(var(--dbx-viewport-height)-6rem)]");
    expect(connectionDialogSource).toContain("max-height: calc(var(--dbx-viewport-height) - 2rem);");
  });

  it("centralizes legacy dialog positioning and layout utility fallbacks", () => {
    const fallbackStart = globalsCss.indexOf("html.dbx-legacy-webview .sm\\:block");
    const splitpanesStart = globalsCss.indexOf("/* Splitpanes */");
    const fallback = globalsCss.slice(fallbackStart, splitpanesStart);

    expect(dialogContentSource).toContain('data-slot="dialog-positioner"');
    expect(dialogScrollContentSource).toContain('data-slot="dialog-positioner"');
    expect(fallback).toContain('[data-slot="dialog-positioner"]');
    expect(fallback).toContain("display: flex !important;");
    expect(fallback).toContain("align-items: center !important;");
    expect(fallback).toContain("justify-content: center !important;");
    expect(fallback).toContain(".sm\\:grid-cols-2");
    expect(fallback).toContain("grid-template-columns: repeat(2, minmax(0, 1fr)) !important;");
    expect(fallback).toContain(".sm\\:grid-cols-\\[minmax\\(0\\,200px\\)_minmax\\(0\\,1fr\\)\\]");
    expect(fallback).toContain(".space-y-1\\.5 > * + *");
    expect(fallback).toContain(".space-y-2\\.5 > * + *");
    expect(scheduledDatabaseBackupSource).toContain("dbx-form-dialog dbx-form-dialog--lg");
    expect(scheduledDatabaseBackupSource).toContain("max-w-[min(720px,calc(100vw-32px))]");
    expect(fallback).toContain('[data-slot="dialog-content"].dbx-form-dialog');
    expect(fallback).toContain('[data-slot="dialog-content"].dbx-form-dialog--lg');
    expect(fallback).toContain("max-width: 45rem !important;");
    expect(fallback).toContain('[data-slot="dialog-content"].dbx-form-dialog [data-slot="select-trigger"]');
    expect(fallback).toContain("height: 2rem !important;");
    expect(fallback).toContain('[data-slot="dialog-content"][class*="max-w-[min(720px"]');
  });

  it("uses a lightweight theme-aware mask without full-window filters", () => {
    expect(dialogOverlaySource).not.toContain("backdrop-filter");
    expect(dialogOverlaySource).toContain("bg-black/25");
    expect(dialogOverlaySource).toContain("dark:bg-background/70");
    expect(globalsCss).not.toContain("dbx-dialog-backdrop");
    expect(globalsCss).not.toContain("filter: blur(4px);");
  });

  it("keeps primary alpha utilities readable in legacy WebViews", () => {
    expect(globalsCss).toContain("--dbx-primary-rgb: 23, 23, 23;");
    expect(globalsCss).toContain("--dbx-primary-rgb: 46, 95, 166;");
    expect(globalsCss).toContain(".bg-primary\\/10");
    expect(globalsCss).toContain("background-color: rgba(var(--dbx-primary-rgb), 0.1) !important;");
    expect(globalsCss).toContain(".border-primary\\/30");
    expect(globalsCss).toContain("border-color: rgba(var(--dbx-primary-rgb), 0.3) !important;");
    expect(globalsCss).toContain(".hover\\:bg-primary\\/15:hover");
    expect(connectionTreeSource).toContain("showActiveConnectionsOnly");
    // Three pre-existing usages plus the sidebar regex-search toggle.
    expect(connectionTreeSource.match(/bg-primary\/10 border-primary\/30/g)?.length).toBe(4);
  });

  it("keeps legacy tab triggers connected to the configured corner style", () => {
    const tabsTriggerRule = globalsCss.match(/\[data-slot="tabs-trigger"\] \{([\s\S]*?)\n  \}/)?.[1];

    expect(tabsTriggerRule).toContain("border-radius: var(--dbx-radius-fixed-6);");
  });

  it("loads connection dialog media fallbacks without CSS transformation", () => {
    expect(desktopIndexSource).toContain('href="/connection-dialog-legacy.css"');
    expect(connectionDialogLegacyCss).toContain("@media (min-width: 640px)");
    expect(connectionDialogLegacyCss).toContain("@media (min-width: 1024px)");
    expect(connectionDialogLegacyCss).toContain("html.dbx-legacy-webview .connection-db-picker-grid");
    expect(connectionDialogLegacyCss).toContain('html.dbx-legacy-webview [data-slot="dialog-content"].connection-dialog-content--config');
    expect(connectionDialogLegacyCss).toContain("min-width: 38rem !important;");
    expect(connectionDialogLegacyCss).toContain("width: 0 !important;");
    expect(connectionDialogLegacyCss).toContain("grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)) !important;");
    expect(connectionDialogLegacyCss).toContain('[data-slot="dialog-content"].connection-dialog-content--config');
    expect(connectionDialogLegacyCss).toMatch(/\[data-slot="dialog-content"\]\.connection-dialog-content--config\s*\{[\s\S]*?width: calc\(100vw - 2rem\) !important;[\s\S]*?min-width: 38rem !important;[\s\S]*?height: 720px !important;[\s\S]*?max-width: 880px !important;[\s\S]*?\}/);
    expect(connectionDialogLegacyCss).toContain("height: 720px !important;");
    expect(connectionDialogLegacyCss).toContain('[data-slot="dialog-content"].connection-dialog-content--config .connection-form-body');
    expect(connectionDialogLegacyCss).toContain("align-content: start !important;");
    expect(connectionDialogSource).toContain("connection-dialog-footer");
    expect(connectionDialogSource).toContain("connection-dialog-test-status");
    expect(connectionDialogLegacyCss).toContain('[data-slot="dialog-content"].connection-dialog-content--config .connection-dialog-footer');
    expect(connectionDialogLegacyCss).toContain("flex-wrap: nowrap !important;");
    expect(connectionDialogLegacyCss).toContain('[data-slot="dialog-content"].connection-dialog-content--config .connection-dialog-test-status');
    expect(connectionDialogLegacyCss).toContain("min-width: 12rem !important;");
    expect(connectionDialogSource).toContain("connection-url-params-row--compact");
    expect(connectionDialogSource).toContain("connection-url-params-row--with-hint");
    expect(connectionDialogSource).toContain("connection-url-params-label");
    expect(connectionDialogLegacyCss).toContain('[data-slot="dialog-content"].connection-dialog-content--config .connection-url-params-row--compact');
    expect(connectionDialogLegacyCss).toContain("align-items: center !important;");
    expect(connectionDialogLegacyCss).toContain('[data-slot="dialog-content"].connection-dialog-content--config .connection-url-params-row--with-hint .connection-url-params-label');
    expect(connectionDialogLegacyCss).toContain("margin-top: 0.5rem !important;");
    expect(connectionDialogLegacyCss).not.toContain("minmax(8rem, 1fr)");
    expect(connectionDialogLegacyCss).toContain(".connection-db-picker-option");
    expect(connectionDialogLegacyCss).not.toContain("width >=");
    expect(connectionDialogSource).not.toContain("@media (min-width: 640px)");
  });

  it("keeps the sidebar table tree scrollbar unchanged outside legacy WebViews", () => {
    expect(connectionTreeSource).toContain('class="sidebar-tree-scrollbar"');
    expect(connectionTreeSource).toMatch(/\.sidebar-tree-scrollbar \{[\s\S]*?opacity: 0;/);
    expect(connectionTreeSource).toContain("html.dbx-legacy-webview .sidebar-tree-scrollbar");
    expect(connectionTreeSource).toMatch(/html\.dbx-legacy-webview \.sidebar-tree-scrollbar \{[\s\S]*?opacity: 0\.9;/);
    expect(connectionTreeSource).toContain("html.dbx-legacy-webview .sidebar-tree-scrollbar__thumb");
    expect(connectionTreeSource).toContain("background: rgba(82, 82, 82, 0.42);");
    expect(connectionTreeSource).toContain("html.dbx-legacy-webview.dark .sidebar-tree-scrollbar__thumb");
    expect(connectionTreeSource).toContain("background: rgba(212, 212, 216, 0.42);");
  });

  it("keeps selected tiles readable in WebViews without color-mix support", () => {
    const fallbackStart = globalsCss.indexOf("@supports not (background-color: color-mix(in srgb, black 10%, transparent))");
    const choiceFallback = globalsCss.indexOf(".dbx-choice-selected", fallbackStart);
    const tileFallback = globalsCss.indexOf(".dbx-tile-selected", fallbackStart);
    const nextSupports = globalsCss.indexOf("@supports (height: 100dvh)", fallbackStart);

    expect(fallbackStart).toBeGreaterThan(-1);
    expect(choiceFallback).toBeGreaterThan(fallbackStart);
    expect(tileFallback).toBeGreaterThan(fallbackStart);
    expect(choiceFallback).toBeLessThan(tileFallback);
    expect(tileFallback).toBeLessThan(nextSupports);
    expect(globalsCss.slice(fallbackStart, tileFallback)).toContain("background-color: rgba(23, 23, 23, 0.08) !important;");
    expect(globalsCss.slice(fallbackStart, tileFallback)).toContain("color: rgb(23, 23, 23) !important;");
    expect(globalsCss.slice(fallbackStart, tileFallback)).toContain(".dbx-choice-selected .text-muted-foreground");
    expect(globalsCss.slice(fallbackStart, tileFallback)).toContain(".dark .dbx-choice-selected");
    expect(globalsCss.slice(fallbackStart, nextSupports)).toContain("background-color: rgba(23, 23, 23, 0.08) !important;");
    expect(globalsCss.slice(fallbackStart, nextSupports)).toContain("color: rgb(23, 23, 23) !important;");
    expect(globalsCss.slice(fallbackStart, nextSupports)).toContain(".dark .dbx-tile-selected");
  });

  it("keeps the driver manager category navigation scoped to legacy WebViews", () => {
    const fallbackStart = driverStoreDialogSource.indexOf("html.dbx-legacy-webview .driver-store-tab");
    const fallbackEnd = driverStoreDialogSource.indexOf("@media (max-width: 900px)", fallbackStart);
    const fallback = driverStoreDialogSource.slice(fallbackStart, fallbackEnd);

    expect(driverStoreDialogSource).toContain("data-driver-category-nav");
    expect(driverStoreDialogSource).toContain("driver-store-agent-results min-w-0 flex-1 overflow-y-auto sm:pl-4");
    expect(fallbackStart).toBeGreaterThan(-1);
    expect(fallbackEnd).toBeGreaterThan(fallbackStart);
    expect(fallback).toContain(".driver-store-tab");
    expect(fallback).toContain("margin-top: 1.25rem !important;");
    expect(fallback).toContain(".driver-store-agent-tab:not([hidden])");
    expect(fallback).toContain(".driver-store-jdbc-tab:not([hidden])");
    expect(fallback).toContain(".driver-store-storage-tab:not([hidden])");
    expect(fallback).toContain("gap: 1.25rem !important;");
    expect(fallback).not.toContain(".driver-store-tab .space-y-");
    expect(fallback).toContain("[data-driver-category-nav]");
    expect(fallback).toContain("width: 10rem !important;");
    expect(fallback).toContain("flex-direction: column !important;");
    expect(fallback).toContain("overflow-y: auto !important;");
    expect(fallback).toContain('[data-driver-category-nav] > button[aria-current="page"]');
    expect(fallback).toContain(".driver-store-agent-results");
    expect(fallback).toContain("width: 0 !important;");
    expect(fallback).toContain("flex: 1 1 0% !important;");
  });

  it("keeps driver manager local import buttons large enough to target", () => {
    const fallbackStart = driverStoreDialogSource.indexOf("html.dbx-legacy-webview .driver-store-local-import-button");
    const fallbackEnd = driverStoreDialogSource.indexOf("@media (max-width: 900px)", fallbackStart);
    const fallback = driverStoreDialogSource.slice(fallbackStart, fallbackEnd);

    expect(driverStoreDialogSource.match(/driver-store-local-import-button h-7 w-7 rounded-md text-xs text-muted-foreground/g)?.length).toBe(3);
    expect(driverStoreDialogSource.match(/variant="ghost"\n\s+class="driver-store-local-import-button/g)?.length).toBe(3);
    expect(fallback).toContain(".driver-store-local-import-button");
    expect(fallback).toContain("width: 2rem !important;");
    expect(fallback).toContain("height: 2rem !important;");
    expect(fallback).toContain(".driver-store-local-import-button svg");
    expect(fallback).toContain("width: 1rem !important;");
    expect(fallback).toContain("height: 1rem !important;");
  });

  it("keeps tunnel profile selection readable in legacy WebViews", () => {
    expect(tunnelProfileManagerSource).toContain("profile.id === selectedId ? 'tunnel-profile-option--selected border-primary bg-primary/5'");
    expect(tunnelProfileManagerSource).toContain("html.dbx-legacy-webview .tunnel-profile-option--selected");
    expect(tunnelProfileManagerSource).toContain("background-color: var(--muted) !important;");
    expect(tunnelProfileManagerSource).toContain("color: var(--foreground) !important;");
    expect(tunnelProfileManagerSource).toContain("html.dbx-legacy-webview .tunnel-profile-option--selected .text-muted-foreground");
  });

  it("keeps transport layer selection readable in legacy WebViews", () => {
    const fallbackStart = connectionDialogSource.indexOf("html.dbx-legacy-webview .connection-db-category-option--selected");
    const fallbackEnd = connectionDialogSource.indexOf(".connection-db-picker-option", fallbackStart);
    const fallback = connectionDialogSource.slice(fallbackStart, fallbackEnd);

    expect(connectionDialogSource).toContain("connection-transport-layer-option--selected border-primary bg-primary/5");
    expect(fallback).toContain(".connection-transport-layer-option--selected");
    expect(fallback).toContain("background-color: rgba(23, 23, 23, 0.08) !important;");
    expect(fallback).toContain(".dark .connection-transport-layer-option--selected");
  });

  it("keeps dark switches visible in legacy WebViews", () => {
    const fallbackStart = switchSource.indexOf('html.dbx-legacy-webview.dark .dbx-switch[data-state="unchecked"] .dbx-switch-thumb');
    const fallback = switchSource.slice(fallbackStart);

    expect(fallbackStart).toBeGreaterThan(-1);
    expect(fallback).toContain('html.dbx-legacy-webview.dark .dbx-switch[data-state="unchecked"] .dbx-switch-thumb');
    expect(fallback).toContain("background-color: rgb(215, 215, 219) !important;");
    expect(fallback).toContain("html.dbx-legacy-webview.dark .dbx-switch {");
    expect(fallback).toContain("background-color: rgba(110, 110, 114, 0.44) !important;");
    expect(fallback).toContain("border-color: rgb(208, 208, 214) !important;");
    expect(fallback).toContain("background-color: rgb(19, 20, 22) !important;");
  });

  it("keeps native number input steppers scoped to legacy WebViews", () => {
    expect(globalsCss).toContain('html.dbx-legacy-webview input[type="number"]');
    expect(globalsCss).toContain('html.dbx-legacy-webview input[type="number"]:not([class*="appearance-none"])::-webkit-inner-spin-button');
    expect(globalsCss).not.toContain('input[type="number"]::-webkit-inner-spin-button');
    expect(globalsCss).toContain("-webkit-appearance: inner-spin-button !important;");
    expect(globalsCss).not.toContain("width: 1.25rem !important;");
    expect(globalsCss).not.toContain("min-height: 1.4rem !important;");
    expect(globalsCss).not.toContain("-webkit-transform: scale(1.45);");
    expect(globalsCss).not.toContain("transform: scale(1.45);");
    expect(globalsCss).toContain('html.dbx-legacy-webview input[type="number"]:not([class*="appearance-none"]):disabled::-webkit-inner-spin-button');
  });

  it("keeps settings field stacks spaced in legacy WebViews", () => {
    const fallbackStart = editorSettingsDialogSource.indexOf("html.dbx-legacy-webview .settings-layout");
    const fallbackEnd = editorSettingsDialogSource.indexOf("@media (max-width: 760px)", fallbackStart);
    const fallback = editorSettingsDialogSource.slice(fallbackStart, fallbackEnd);

    expect(fallbackStart).toBeGreaterThan(-1);
    expect(fallbackEnd).toBeGreaterThan(fallbackStart);
    expect(fallback).not.toContain(".settings-layout .space-y-");
    expect(fallback).toContain('.settings-layout [data-slot="select-trigger"][data-size="default"]:not(.h-7)');
    expect(fallback).toContain("height: 2rem !important;");
    expect(fallback).toContain('.settings-layout [data-slot="select-trigger"].h-9');
    expect(fallback).toContain('.settings-layout [data-slot="select-trigger"][data-size="sm"],');
    expect(fallback).toContain('.settings-layout [data-slot="select-trigger"].h-7');
    expect(fallback).toContain("height: 1.75rem !important;");
    expect(editorSettingsDialogSource).toContain('SelectTrigger class="col-span-2" inputClass="h-8 text-xs"');
    expect(editorSettingsDialogSource).not.toContain('SelectTrigger class="col-span-2 h-8 text-xs"');
    expect(fallback).toContain(".settings-layout .settings-shortcut-row");
    expect(fallback).toContain("grid-template-columns: minmax(0, 1fr) auto !important;");
    expect(fallback).toContain(".settings-layout .settings-shortcut-actions");
    expect(fallback).toContain("justify-self: end !important;");
    expect(editorSettingsDialogSource).toContain("settings-shortcut-controls flex items-center justify-end gap-1.5");
    expect(editorSettingsDialogSource).toContain("settings-shortcut-action-button h-7 w-7");
    expect(editorSettingsDialogSource).toContain("html.dbx-legacy-webview .settings-shortcut-row:hover .settings-shortcut-action-button");
    expect(editorSettingsDialogSource).toContain("opacity: 1 !important;");
    expect(fallback).toContain(".settings-layout .settings-shortcut-controls");
    expect(fallback).toContain("flex-direction: row !important;");
    expect(fallback).toContain("justify-content: flex-end !important;");
    expect(editorSettingsDialogSource).toContain("settings-export-number-input h-9 w-28 [&::-webkit-inner-spin-button]:appearance-none");
    expect(editorSettingsDialogSource).toContain("settings-export-number-input h-9 w-32 [&::-webkit-inner-spin-button]:appearance-none");
    expect(editorSettingsDialogSource).not.toContain("\n.settings-export-number-input {");
    expect(fallback).toContain(".settings-layout .settings-export-number-input");
    expect(fallback).toContain("line-height: 1.25rem !important;");
    expect(fallback).toContain("-webkit-appearance: inner-spin-button !important;");
    expect(fallback).toContain("::-webkit-inner-spin-button");
    expect(editorSettingsDialogSource).toContain("settings-mcp-config-tabs");
    expect(editorSettingsDialogSource).toContain("settings-mcp-config-tab");
    expect(fallback).toContain(".settings-layout .settings-mcp-config-tabs");
    expect(fallback).toContain("gap: 0.25rem !important;");
    expect(fallback).toContain(".settings-layout .settings-mcp-config-tab");
    expect(fallback).toContain("flex: 0 0 auto !important;");
    expect(fallback).toContain("min-width: max-content !important;");
    expect(editorSettingsDialogSource).toContain('class="settings-ai-back-button"');
    expect(fallback).toContain(".settings-ai-back-button");
    expect(fallback).toContain("margin-left: -0.625rem !important;");
    expect(editorSettingsDialogSource).toContain("settings-about-section-header flex flex-col gap-3");
    expect(editorSettingsDialogSource).toContain("settings-about-section-actions flex shrink-0 flex-wrap items-center gap-2");
    expect(changelogPanelSource).toContain("settings-about-section-header flex flex-col gap-3");
    expect(changelogPanelSource).toContain("settings-about-section-actions flex shrink-0 flex-wrap items-center gap-2");
    expect(fallback).toContain(".settings-about-section-header");
    expect(fallback).toContain("justify-content: space-between !important;");
    expect(fallback).toContain(".settings-about-section-actions");
    expect(fallback).toContain("margin-left: auto !important;");
  });

  it("uses a runtime capability check instead of an OKLCH-only CSS proxy", () => {
    expect(legacyWebViewSource).toContain("color-mix");
    expect(legacyWebViewSource).toContain("has-selector");
    expect(legacyWebViewSource).toContain("dynamic-viewport");
    expect(legacyWebViewSource).toContain("min-function");
    expect(legacyWebViewSource).toContain("dbx-legacy-webview");
    expect(mainSource).toContain("applyLegacyWebViewClass();");
  });
});
