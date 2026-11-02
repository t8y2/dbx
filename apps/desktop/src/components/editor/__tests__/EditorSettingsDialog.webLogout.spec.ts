// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

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

vi.mock("@/components/settings/ChangelogPanel.vue", async () => {
  const { defineComponent } = await import("vue");
  return { default: defineComponent({ setup: () => () => null }) };
});

vi.mock("@/stores/settingsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/settingsStore")>();
  const store = {
    settingsPageActive: false,
    editorSettings: actual.DEFAULT_EDITOR_SETTINGS,
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

describe("EditorSettingsDialog web logout", () => {
  it("renders logout button under security tab and emits logout event", async () => {
    let logoutEmitted = false;
    const host = document.createElement("div");
    document.body.appendChild(host);

    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(EditorSettingsDialog, {
              variant: "page",
              initialTab: "security" as any,
              onLogout: () => {
                logoutEmitted = true;
              },
            });
        },
      }),
    );
    app.use(createPinia());
    app.mount(host);
    mountedApps.push({ app, host });

    await nextTick();
    await Promise.resolve();

    const buttons = Array.from(host.querySelectorAll("button"));
    const logoutBtn = buttons.find((btn) => btn.textContent?.includes("auth.logout"));
    expect(logoutBtn).toBeDefined();

    logoutBtn?.click();
    expect(logoutEmitted).toBe(true);
  });
});
