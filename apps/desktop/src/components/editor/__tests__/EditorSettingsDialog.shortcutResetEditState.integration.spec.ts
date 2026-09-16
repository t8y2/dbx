// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { SHORTCUT_DEFINITIONS } from "@/lib/editor/shortcutRegistry";
import { formatShortcutDisplay } from "@/lib/editor/shortcutDisplay";

// Reviewer follow-up to the source-contract spec
// (EditorSettingsDialog.shortcutResetEditState.spec.ts): prove the actual UI
// state transition for #9066 — entering a shortcut row's capture state and
// clicking restore-defaults must return the row to its initial pill display,
// for both the per-tab footer button and the About tab's full reset (whose
// click path is reachable because the capture state survives tab switches).

vi.mock("vue-i18n", async () => {
  const { ref } = await import("vue");
  const locale = ref("en");
  const t = (key: string) => key;
  return {
    // The real @/i18n index builds its instance at module scope; satisfy it.
    createI18n: () => ({ global: { t, locale }, install: () => undefined }),
    useI18n: () => ({ t, locale }),
  };
});

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Dialog: passthrough,
    DialogContent: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup(_props, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});

// ChangelogPanel fires a changelog network fetch on mount (About tab); the
// network is irrelevant to the reset contract under test.
vi.mock("@/components/settings/ChangelogPanel.vue", async () => {
  const { defineComponent } = await import("vue");
  return { default: defineComponent({ setup: () => () => null }) };
});

// Keep every real constant/normalizer export, but back the store composable
// with a plain stub so the dialog boots without the Tauri backend. A custom
// formatSql binding makes the value reset observable in the row pill.
vi.mock("@/stores/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/settingsStore")>();
  const store = {
    settingsPageActive: false,
    editorSettings: {
      ...actual.DEFAULT_EDITOR_SETTINGS,
      shortcuts: { ...actual.DEFAULT_EDITOR_SETTINGS.shortcuts, formatSql: "Ctrl+Alt+F" },
    },
    desktopSettings: actual.DEFAULT_DESKTOP_SETTINGS,
    mcpGlobalPolicy: { configured: false, readOnly: false },
    aiConfigs: [],
    aiDefaultTemplatesByDbType: {},
    defaultAiMode: "ask",
    restoreLastConversation: false,
    initMcpGlobalPolicy: vi.fn(async () => undefined),
    updateMcpGlobalPolicy: vi.fn(async () => undefined),
    initAiConfigs: vi.fn(async () => undefined),
    initDesktopSettings: vi.fn(async () => undefined),
    updateEditorSettingsAndPersist: vi.fn(async () => undefined),
    updateEditorSettings: vi.fn(),
    persistEditorSettings: vi.fn(async () => undefined),
    updateDesktopSettings: vi.fn(async () => undefined),
    reloadAiConfigs: vi.fn(async () => undefined),
    removeTemplateFromDefaultAndLastUsed: vi.fn(),
    setDefaultTemplatesForDbType: vi.fn(),
    updateAiConfigItem: vi.fn(),
    createAiConfig: vi.fn(),
    deleteAiConfig: vi.fn(),
    setDefaultAiConfig: vi.fn(),
    setDefaultAiMode: vi.fn(),
    setRestoreLastConversation: vi.fn(),
  };
  return { ...actual, useSettingsStore: () => store };
});

import EditorSettingsDialog from "../EditorSettingsDialog.vue";

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

async function flushAsyncUpdates() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

// Page variant keeps the root a plain div (no reka-ui Dialog teleport), and
// changing `initialTab` drives the component's real tab watcher, so both
// reset entrypoints are reached through genuine rendered controls.
async function mountSettingsPage(initialTab: string) {
  const host = document.createElement("div");
  document.body.append(host);
  let setTab: (tab: string) => void = () => {};
  const app = createApp(
    defineComponent({
      setup() {
        const tab = ref(initialTab);
        setTab = (value: string) => {
          tab.value = value;
        };
        return () => h(EditorSettingsDialog, { variant: "page", initialTab: tab.value });
      },
    }),
  );
  app.use(createPinia());
  app.mount(host);
  mountedApps.push({ app, host });
  await flushAsyncUpdates();
  return { host, setTab };
}

function formatSqlRowControls(host: HTMLElement) {
  const input = host.querySelector<HTMLInputElement>('input[data-shortcut-input="formatSql"]');
  if (!input) throw new Error("formatSql shortcut row is not rendered");
  const scope = input.closest(".settings-shortcut-actions") ?? input.parentElement!;
  return {
    input,
    editButton: scope.querySelector<HTMLButtonElement>('button[aria-label="settings.shortcutPressShortcut"]'),
    cancelButton: Array.from(scope.querySelectorAll("button")).find((button) => button.textContent?.trim() === "settings.cancel") ?? null,
  };
}

function findButtonByText(host: HTMLElement, text: string) {
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ?? null;
}

function formatSqlDefaultPill() {
  const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === "formatSql");
  if (!definition) throw new Error("formatSql definition missing from SHORTCUT_DEFINITIONS");
  return formatShortcutDisplay(definition.defaultShortcut);
}

describe("EditorSettingsDialog shortcut reset exits capture state (behavior)", () => {
  it("per-tab restore-defaults exits the capture state and restores the default pill", async () => {
    const { host } = await mountSettingsPage("shortcuts");

    const initial = formatSqlRowControls(host);
    expect(initial.input.value).toBe(formatShortcutDisplay("Ctrl+Alt+F"));
    expect(initial.editButton).toBeTruthy();
    expect(initial.cancelButton).toBeNull();

    initial.editButton!.click();
    await flushAsyncUpdates();

    const editing = formatSqlRowControls(host);
    expect(editing.input.value).toBe("");
    expect(editing.input.placeholder).toBe("settings.shortcutPressShortcut");
    expect(editing.cancelButton).toBeTruthy();

    const resetButton = findButtonByText(host, "settings.resetDefaults");
    expect(resetButton).toBeTruthy();
    resetButton!.click();
    await flushAsyncUpdates();

    const restored = formatSqlRowControls(host);
    expect(restored.input.value).toBe(formatSqlDefaultPill());
    expect(restored.cancelButton).toBeNull();
    expect(restored.editButton).toBeTruthy();
  });

  it("full reset on the about tab also exits a capture state that leaked across tabs", async () => {
    const { host, setTab } = await mountSettingsPage("shortcuts");

    formatSqlRowControls(host).editButton!.click();
    await flushAsyncUpdates();
    expect(formatSqlRowControls(host).cancelButton).toBeTruthy();

    setTab("about");
    await flushAsyncUpdates();
    const fullResetButton = findButtonByText(host, "settings.resetAllDefaults");
    expect(fullResetButton).toBeTruthy();
    fullResetButton!.click();
    await flushAsyncUpdates();

    setTab("shortcuts");
    await flushAsyncUpdates();

    const restored = formatSqlRowControls(host);
    expect(restored.input.value).toBe(formatSqlDefaultPill());
    expect(restored.cancelButton).toBeNull();
    expect(restored.editButton).toBeTruthy();
  });
});
