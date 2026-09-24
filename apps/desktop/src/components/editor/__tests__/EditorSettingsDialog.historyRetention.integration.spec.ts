// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { DEFAULT_EDITOR_SETTINGS } from "@/stores/settingsStore";

const hoisted = vi.hoisted(() => ({ shortcuts: {} as Record<string, string>, limit: 5000, failLoad: false, failSave: false, closes: [] as boolean[], saves: [] as number[] }));

vi.mock("vue-i18n", async () => {
  const { ref } = await import("vue");
  const locale = ref("en");
  const t = (key: string) => key;
  return {
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
    Dialog: defineComponent({
      props: { open: { type: Boolean, default: false } },
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("div", slots.default?.()) : null,
    }),
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
      setup(props, { attrs, slots }) {
        return () => h("button", { ...attrs, disabled: (props as { disabled?: boolean }).disabled ? true : undefined }, slots.default?.());
      },
      props: { disabled: { type: Boolean, default: false } },
    }),
  };
});

// ChangelogPanel fires a network fetch on mount (About tab); irrelevant here.
vi.mock("@/components/settings/ChangelogPanel.vue", async () => {
  const { defineComponent } = await import("vue");
  return { default: defineComponent({ setup: () => () => null }) };
});

// Back the store composable with a stub so the dialog boots without the Tauri
// backend, but read `shortcuts` through the hoisted object so each test can seed
// the configuration it wants before mounting.
vi.mock("@/stores/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/settingsStore")>();
  const store = {
    settingsPageActive: false,
    editorSettings: {
      ...actual.DEFAULT_EDITOR_SETTINGS,
      get shortcuts() {
        return hoisted.shortcuts;
      },
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

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    loadHistoryRetentionLimit: async () => {
      if (hoisted.failLoad) throw new Error("load failed");
      return hoisted.limit;
    },
    saveHistoryRetentionLimit: async (limit: number) => {
      if (hoisted.failSave) throw new Error("save failed");
      hoisted.saves.push(limit);
      hoisted.limit = limit;
    },
  };
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
  for (let i = 0; i < 5; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

function defaults() {
  return { ...DEFAULT_EDITOR_SETTINGS.shortcuts };
}

async function mountDataTab() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(defineComponent({ setup: () => () => h(EditorSettingsDialog, { variant: "page", initialTab: "data", "onUpdate:open": (open: boolean) => hoisted.closes.push(open) }) }));
  app.use(createPinia());
  app.mount(host);
  mountedApps.push({ app, host });
  await flushAsyncUpdates();
  return host;
}

function button(host: HTMLElement, text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)!;
}

beforeEach(() => {
  hoisted.shortcuts = defaults();
  hoisted.limit = 5000;
  hoisted.failLoad = false;
  hoisted.failSave = false;
  hoisted.saves = [];
  hoisted.closes = [];
});

// Mounts the complete settings workbench; concurrent Rust/typecheck jobs can
// delay rendering on developer machines without changing the assertions.
describe("query history retention settings", { timeout: 30_000 }, () => {
  it("loads the server limit and applies a selected limit only on Apply", async () => {
    const host = await mountDataTab();
    const control = host.querySelector<HTMLElement>("#history-retention-limit");
    expect(control, "retention setting must be available in Data settings").not.toBeNull();
    expect(control!.textContent).toContain("5000");
    expect(host.textContent).toContain("settings.historyRetentionDescription");
    expect(hoisted.saves).toEqual([]);
    control!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await flushAsyncUpdates();
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((option) => option.textContent?.trim())).toEqual(["200", "1000", "5000", "10000", "settings.historyRetentionUnlimited"]);
    const option = options[0];
    option.focus();
    option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flushAsyncUpdates();
    expect(control!.textContent).toContain("200");
    expect(hoisted.saves).toEqual([]);
    const apply = button(host, "settings.apply");
    expect(apply.disabled).toBe(false);
    apply.click();
    await flushAsyncUpdates();
    expect(hoisted.limit).toBe(200);
    expect(apply.disabled).toBe(true);
  });

  it("keeps the draft on save failure and can retry", async () => {
    const host = await mountDataTab();
    button(host, "settings.resetDefaults").click();
    await flushAsyncUpdates();
    expect(host.querySelector("#history-retention-limit")!.textContent).toContain("1000");
    hoisted.failSave = true;
    button(host, "settings.apply").click();
    await flushAsyncUpdates();
    expect(hoisted.limit).toBe(5000);
    expect(button(host, "settings.apply").disabled).toBe(false);
    hoisted.failSave = false;
    button(host, "settings.apply").click();
    await flushAsyncUpdates();
    expect(hoisted.limit).toBe(1000);
  });

  it("Apply and Close waits for persistence and reloads the saved value", async () => {
    const host = await mountDataTab();
    button(host, "settings.resetDefaults").click();
    await flushAsyncUpdates();
    hoisted.failSave = true;
    button(host, "settings.applyAndClose").click();
    await flushAsyncUpdates();
    expect(hoisted.closes).toEqual([]);
    expect(hoisted.limit).toBe(5000);
    hoisted.failSave = false;
    button(host, "settings.applyAndClose").click();
    await flushAsyncUpdates();
    expect(hoisted.closes).toEqual([false]);
    expect(hoisted.limit).toBe(1000);
    const reopened = await mountDataTab();
    expect(reopened.querySelector("#history-retention-limit")!.textContent).toContain("1000");
  });

  it("discarding an unapplied change does not save it", async () => {
    const host = await mountDataTab();
    button(host, "settings.resetDefaults").click();
    await flushAsyncUpdates();
    button(host, "common.close").click();
    await flushAsyncUpdates();
    button(host, "settings.unsavedChangesCloseDiscard").click();
    await flushAsyncUpdates();
    expect(hoisted.closes).toEqual([false]);
    expect(hoisted.saves).toEqual([]);
    const reopened = await mountDataTab();
    expect(reopened.querySelector("#history-retention-limit")!.textContent).toContain("5000");
  });

  it("does not overwrite server history retention when loading fails", async () => {
    hoisted.failLoad = true;
    const host = await mountDataTab();
    expect((host.querySelector("#history-retention-limit") as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain("settings.historyRetentionLoadFailed");
    button(host, "settings.resetDefaults").click();
    button(host, "settings.apply").click();
    await flushAsyncUpdates();
    expect(hoisted.saves).toEqual([]);
    hoisted.failLoad = false;
    button(host, "common.retry").click();
    await flushAsyncUpdates();
    expect(host.querySelector("#history-retention-limit")!.textContent).toContain("5000");
  });
});
