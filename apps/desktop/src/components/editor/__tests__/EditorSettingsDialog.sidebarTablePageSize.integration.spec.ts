// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { DEFAULT_DESKTOP_SETTINGS, DEFAULT_EDITOR_SETTINGS, type DesktopSettings } from "@/stores/settingsStore";

const hoisted = vi.hoisted(() => ({
  shortcuts: {} as Record<string, string>,
  desktop: null as DesktopSettings | null,
  closes: [] as boolean[],
  updateDesktopCalls: [] as Array<Partial<DesktopSettings>>,
}));

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

vi.mock("@/components/settings/ChangelogPanel.vue", async () => {
  const { defineComponent } = await import("vue");
  return { default: defineComponent({ setup: () => () => null }) };
});

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [],
    sidebarLayout: { groups: [], order: [] },
    activeConnectionId: null,
    getConfig: () => null,
    databaseCompatibilityMode: () => null,
    refreshAllTree: vi.fn(async () => undefined),
    refreshSidebarObjectPagination: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/stores/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/settingsStore")>();
  hoisted.desktop = { ...actual.DEFAULT_DESKTOP_SETTINGS };
  const store = {
    settingsPageActive: false,
    editorSettings: {
      ...actual.DEFAULT_EDITOR_SETTINGS,
      get shortcuts() {
        return hoisted.shortcuts;
      },
    },
    get desktopSettings() {
      if (!hoisted.desktop) throw new Error("desktop settings were not initialized");
      return hoisted.desktop;
    },
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
    updateDesktopSettings: vi.fn(async (partial: Partial<DesktopSettings>) => {
      hoisted.updateDesktopCalls.push(partial);
      // Mirror production: persist path runs normalizeDesktopSettings so ≤0 falls back.
      hoisted.desktop = actual.normalizeDesktopSettings({ ...hoisted.desktop, ...partial });
    }),
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
    loadHistoryRetentionLimit: async () => 5000,
    saveHistoryRetentionLimit: async () => undefined,
    loadMcpHistoryRetentionLimit: async () => 5000,
    saveMcpHistoryRetentionLimit: async () => undefined,
    cleanupMcpHistoryRetention: async () => 0,
  };
});

import EditorSettingsDialog from "../EditorSettingsDialog.vue";
import { TooltipProvider } from "@/components/ui/tooltip";

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

async function mountNavigationTab() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(TooltipProvider, null, {
          default: () =>
            h(EditorSettingsDialog, {
              variant: "page",
              initialTab: "navigation",
              "onUpdate:open": (open: boolean) => hoisted.closes.push(open),
            }),
        }),
    }),
  );
  app.use(createPinia());
  app.mount(host);
  mountedApps.push({ app, host });
  await flushAsyncUpdates();
  return host;
}

function button(host: HTMLElement, text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)!;
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  hoisted.shortcuts = defaults();
  hoisted.desktop = { ...DEFAULT_DESKTOP_SETTINGS };
  hoisted.closes = [];
  hoisted.updateDesktopCalls = [];
});

function desktop(): DesktopSettings {
  if (!hoisted.desktop) throw new Error("desktop settings were not initialized");
  return hoisted.desktop;
}

describe("sidebar table page size settings", { timeout: 30_000 }, () => {
  it("re-syncs a non-positive draft after Apply so hasChanges is not sticky", async () => {
    const host = await mountNavigationTab();
    const input = host.querySelector<HTMLInputElement>("#sidebar-table-page-size");
    expect(input, "sidebar table page size must be on the Navigation tab").not.toBeNull();
    expect(input!.value).toBe(String(DEFAULT_DESKTOP_SETTINGS.sidebar_table_page_size));

    setInputValue(input!, "0");
    await flushAsyncUpdates();
    const apply = button(host, "settings.apply");
    expect(apply.disabled, "typing 0 must stage a dirty draft").toBe(false);

    apply.click();
    await flushAsyncUpdates();

    expect(hoisted.updateDesktopCalls.at(-1)?.sidebar_table_page_size).toBe(0);
    expect(desktop().sidebar_table_page_size).toBe(DEFAULT_DESKTOP_SETTINGS.sidebar_table_page_size);
    expect(input!.value).toBe(String(DEFAULT_DESKTOP_SETTINGS.sidebar_table_page_size));
    expect(apply.disabled, "draft must re-sync to the normalized persisted value").toBe(true);
  });

  it("Apply and Close succeeds after a non-positive sidebar page size apply", async () => {
    const host = await mountNavigationTab();
    const input = host.querySelector<HTMLInputElement>("#sidebar-table-page-size")!;
    setInputValue(input, "-5");
    await flushAsyncUpdates();

    button(host, "settings.applyAndClose").click();
    await flushAsyncUpdates();

    expect(desktop().sidebar_table_page_size).toBe(DEFAULT_DESKTOP_SETTINGS.sidebar_table_page_size);
    expect(hoisted.closes).toEqual([false]);
  });
});
