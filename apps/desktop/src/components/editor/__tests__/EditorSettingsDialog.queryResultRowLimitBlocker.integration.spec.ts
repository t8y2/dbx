// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { DEFAULT_EDITOR_SETTINGS } from "@/stores/settingsStore";

const hoisted = vi.hoisted(() => ({
  retentionLimit: 5000,
  editorSettings: {} as Record<string, unknown>,
  updateEditorSettings: vi.fn(),
  persistEditorSettings: vi.fn(async () => undefined),
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

// ChangelogPanel fires a network fetch on mount (About tab); irrelevant here.
vi.mock("@/components/settings/ChangelogPanel.vue", async () => {
  const { defineComponent } = await import("vue");
  return { default: defineComponent({ setup: () => () => null }) };
});

vi.mock("@/stores/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/settingsStore")>();
  const store = {
    settingsPageActive: false,
    get editorSettings() {
      return hoisted.editorSettings;
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
    // Mirror the real store: applying a patch also becomes the new persisted
    // settings, which is what persistSettings() re-baselines the draft against.
    updateEditorSettings: (patch: Record<string, unknown>) => {
      hoisted.updateEditorSettings(patch);
      hoisted.editorSettings = { ...hoisted.editorSettings, ...(JSON.parse(JSON.stringify(patch)) as Record<string, unknown>) };
    },
    persistEditorSettings: hoisted.persistEditorSettings,
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
    loadHistoryRetentionLimit: async () => hoisted.retentionLimit,
    saveHistoryRetentionLimit: async (limit: number) => {
      hoisted.retentionLimit = limit;
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

async function mountDataTab() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(EditorSettingsDialog, {
          variant: "page",
          initialTab: "data",
          "onUpdate:open": () => undefined,
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
  hoisted.retentionLimit = 5000;
  hoisted.updateEditorSettings.mockClear();
  hoisted.persistEditorSettings.mockClear();
  // The exact persisted state reported for #9994: the result-grid menu's
  // "set as default" wrote pageSize = 1000 while the row cap stayed at 500,
  // so the stored pair already violates the "cap >= page size" rule that the
  // settings dialog used to treat as an unconditional apply blocker.
  hoisted.editorSettings = {
    ...DEFAULT_EDITOR_SETTINGS,
    pageSize: 1000,
    queryResultMaxRowsEnabled: true,
    queryResultMaxRows: 500,
  };
});

// Regression for https://github.com/t8y2/dbx/issues/9994: with an
// already-persisted cap < page size pair, hasBlockingQueryResultRowLimit made
// every Apply button dead for the rest of the session. Users could not save
// any unrelated setting (the report was a font change) and got no hint about
// why, because the offending row lives on another tab.
describe("EditorSettingsDialog row-limit apply blocker", { timeout: 30_000 }, () => {
  it("does not block unrelated edits when the stored cap/page-size pair is already invalid", async () => {
    const host = await mountDataTab();
    const apply = button(host, "settings.apply");
    expect(apply.disabled, "nothing changed yet, so Apply starts disabled").toBe(true);
    // The row keeps telling the truth about the stored pair instead of hiding it.
    expect(host.textContent).toContain("settings.queryResultMaxRowsTooSmall");

    // Any edit outside the cap/page-size pair (the report used the UI font).
    setInputValue(host.querySelector<HTMLInputElement>("#table-open-page-size")!, "200");
    await flushAsyncUpdates();
    expect(apply.disabled, "an unrelated edit must be saveable").toBe(false);
  });

  it("still blocks an invalid pair the user creates in this dialog", async () => {
    const host = await mountDataTab();
    const apply = button(host, "settings.apply");
    const maxRows = host.querySelector<HTMLInputElement>("#query-result-max-rows")!;

    maxRows.dispatchEvent(new Event("input", { bubbles: true }));
    await flushAsyncUpdates();
    setInputValue(maxRows, "400");
    await flushAsyncUpdates();
    expect(maxRows.getAttribute("aria-invalid")).toBe("true");
    expect(apply.disabled, "cap below page size must keep Apply disabled").toBe(true);

    setInputValue(maxRows, "1500");
    await flushAsyncUpdates();
    expect(apply.disabled).toBe(false);
  });

  it("lets an unrelated edit apply end to end", async () => {
    const host = await mountDataTab();
    setInputValue(host.querySelector<HTMLInputElement>("#table-open-page-size")!, "200");
    await flushAsyncUpdates();
    const apply = button(host, "settings.apply");
    expect(apply.disabled).toBe(false);
    apply.click();
    await flushAsyncUpdates();
    const patch = hoisted.updateEditorSettings.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(patch, "Apply must reach the settings store").toBeTruthy();
    expect(patch!.tableOpenPageSize).toBe(200);
    expect(hoisted.persistEditorSettings).toHaveBeenCalled();
    expect(apply.disabled, "the draft is the saved baseline again").toBe(true);
  });
});
