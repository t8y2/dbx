// @vitest-environment happy-dom
import { createApp, h, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PluginGraphicsEngineSection from "./PluginGraphicsEngineSection.vue";
import type { InstalledPlugin } from "@/types/database";

const mocks = vi.hoisted(() => ({ state: null as any, save: vi.fn(), toast: vi.fn() }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => mocks.state }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

function plugin(id: string, withUi: boolean): InstalledPlugin {
  return {
    manifest: { id, version: "1.0.0", name: id, drivers: [], entrypoints: withUi ? { ui: { root: "ui", entry: "ui/index.html" } } : undefined },
  } as unknown as InstalledPlugin;
}

let app: ReturnType<typeof createApp>;
let container: HTMLDivElement;

function mount(target: InstalledPlugin) {
  container = document.createElement("div");
  document.body.append(container);
  app = createApp({ render: () => h(PluginGraphicsEngineSection, { plugin: target }) });
  app.mount(container);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = reactive({
    isEditorSettingsLoaded: true,
    editorSettings: { pluginGraphicsEngineIds: [] },
    updateEditorSettingsAndPersist: mocks.save,
  });
  mocks.save.mockImplementation(async (partial: any) => {
    Object.assign(mocks.state.editorSettings, partial);
  });
});

afterEach(() => {
  app.unmount();
  container.remove();
});

describe("plugin graphics engine section", () => {
  it("stays hidden for plugins without a ui entrypoint", () => {
    mount(plugin("io.dbx.backend-only", false));
    expect(container.querySelector("[data-plugin-graphics-engine]")).toBeNull();
  });

  it("grants and revokes the plugin without touching other grants", async () => {
    mocks.state.editorSettings.pluginGraphicsEngineIds = ["io.dbx.other"];
    mount(plugin("io.github.t8y2.s3", true));
    const toggle = container.querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    toggle.click();
    await vi.waitFor(() => expect(mocks.state.editorSettings.pluginGraphicsEngineIds).toEqual(["io.dbx.other", "io.github.t8y2.s3"]));
    await vi.waitFor(() => expect(container.querySelector<HTMLElement>('[role="switch"]')!.getAttribute("aria-checked")).toBe("true"));

    container.querySelector<HTMLElement>('[role="switch"]')!.click();
    await vi.waitFor(() => expect(mocks.state.editorSettings.pluginGraphicsEngineIds).toEqual(["io.dbx.other"]));
  });

  it("toasts when persisting the grant fails", async () => {
    mount(plugin("io.github.t8y2.s3", true));
    mocks.save.mockRejectedValueOnce(new Error("disk full"));
    container.querySelector<HTMLElement>('[role="switch"]')!.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalled());
    expect(mocks.state.editorSettings.pluginGraphicsEngineIds).toEqual([]);
  });
});
