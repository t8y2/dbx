// @vitest-environment happy-dom
import { createApp, defineComponent, h } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void | Promise<void>>(),
  editor: vi.fn(),
  desktop: vi.fn(),
  local: vi.fn(),
  theme: vi.fn(),
  locale: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ applySharedEditorSettings: mocks.editor, applySharedDesktopSettings: mocks.desktop }) }));
vi.mock("@/lib/app/appAppearance", () => ({ setLocalAppearance: mocks.local }));
vi.mock("@/composables/useTheme", () => ({ applySharedTheme: mocks.theme }));
vi.mock("@/i18n", () => ({ applySharedLocale: mocks.locale }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return mocks.unlisten;
  },
}));
import { useWindowSettingsSync } from "../useWindowSettingsSync";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
});

describe("window-wide settings subscription", () => {
  it("applies shared theme, language, fonts and scale without republishing them", async () => {
    const app = createApp(
      defineComponent({
        setup() {
          useWindowSettingsSync();
          return () => h("div");
        },
      }),
    );
    app.mount(document.createElement("div"));
    await vi.waitFor(() => expect(mocks.listeners.size).toBe(3));
    const editor = { fontFamily: "monospace", uiFontFamily: "Arial", fontSize: 20, uiScale: 1.5 };
    await mocks.listeners.get("dbx:editor-settings-changed")!({ payload: editor });
    expect(mocks.editor).toHaveBeenCalledWith(editor);
    const appearance = { themeMode: "dark", themePalette: "sage", locale: "zh-CN" };
    await mocks.listeners.get("dbx:appearance-changed")!({ payload: appearance });
    expect(mocks.theme).toHaveBeenCalledWith(appearance);
    expect(mocks.local).toHaveBeenCalledWith(appearance);
    expect(mocks.locale).toHaveBeenCalledWith("zh-CN");
    await mocks.listeners.get("dbx:desktop-settings-changed")!({ payload: { quit_on_close: true } });
    expect(mocks.desktop).toHaveBeenCalledWith({ quit_on_close: true });
    app.unmount();
    expect(mocks.unlisten).toHaveBeenCalledTimes(3);
  });
});
