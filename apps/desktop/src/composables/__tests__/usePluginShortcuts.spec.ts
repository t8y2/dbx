// @vitest-environment happy-dom
import { createApp, h, reactive, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePluginShortcuts } from "../usePluginShortcuts";
import { addPluginDockEntry, usePluginBottomDock } from "@/lib/plugins/pluginBottomDock";

const mocks = vi.hoisted(() => ({ list: vi.fn(), query: null as any, locale: null as any, settings: null as any }));
vi.mock("@/lib/backend/api", () => ({ listPlugins: mocks.list }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => mocks.query }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => mocks.settings }));
vi.mock("vue-i18n", async (original) => ({ ...(await original<typeof import("vue-i18n")>()), useI18n: () => ({ locale: mocks.locale, t: (key: string) => key }) }));

const fixture = (id: string, presentation = "panel") => ({
  compatibility: { compatible: true },
  manifest: {
    id,
    name: id,
    version: "1.0.0",
    drivers: [],
    contributions: [
      { type: "workbench", id: "workbench", label: "Workbench" },
      { type: "command", id: "open", label: "Open", action: { type: "open-workbench", workbench: "workbench", presentation } },
    ],
  },
});
let app: ReturnType<typeof createApp>;
let shortcuts: ReturnType<typeof usePluginShortcuts>;
async function mount() {
  app = createApp({
    setup() {
      shortcuts = usePluginShortcuts();
      return () => h("div");
    },
  });
  app.mount(document.createElement("div"));
  await vi.waitFor(() => expect(shortcuts.entries.value.length).toBeGreaterThan(0));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.locale = ref("en");
  mocks.settings = reactive({ editorSettings: { pluginShortcuts: { order: [], hiddenPluginIds: [] } } });
  mocks.query = reactive({ tabs: [], activeTabId: null, openPluginWorkbench: vi.fn(), openPluginFilesystem: vi.fn() });
  mocks.list.mockResolvedValue([fixture("a"), fixture("b")]);
  const dock = usePluginBottomDock();
  dock.entries.value = [];
  dock.visible.value = false;
  dock.activeEntryId.value = null;
});
afterEach(() => app?.unmount());
describe("shortcut dispatch", () => {
  it.each([
    { source: undefined, restored: false },
    { source: undefined, restored: true },
    { source: "open", restored: true },
    { source: "other", restored: true },
  ])("preserves a reused tab and its context (source=$source, restored=$restored)", async ({ source, restored }) => {
    setActivePinia(createPinia());
    const { useQueryStore } = await vi.importActual<typeof import("@/stores/queryStore")>("@/stores/queryStore");
    const query = useQueryStore();
    mocks.query = query;
    const oldId = query.openPluginWorkbench("tab", "workbench", {
      commandId: source,
      title: "Existing session",
      context: { workbenchId: "existing-session", retained: { value: 1 } },
    });
    // Restored tabs contain serialized legacy metadata, without commandId.
    if (restored) query.tabs = JSON.parse(JSON.stringify(query.tabs));
    const metadata = query.tabs[0].pluginWorkbench!;
    const context = metadata.context;
    const plugin = fixture("tab", "tab");
    plugin.manifest.contributions.push({ ...(plugin.manifest.contributions[1] as any), id: "other", label: "Other function" });
    plugin.manifest.contributions.push({ type: "menus", id: "menus", items: ["open", "other"].map((command) => ({ command, location: "appToolbar", group: "navigation", order: 0, default_visible: true })) } as any);
    mocks.list.mockResolvedValue([plugin]);
    await mount();
    const entry = shortcuts.entries.value.find((entry) => entry.targetId === "open")!;
    const other = shortcuts.entries.value.find((entry) => entry.targetId === "other")!;
    shortcuts.open(entry);
    expect(query.activeTabId).toBe(oldId);
    expect(query.tabs).toHaveLength(1);
    expect(query.tabs[0].pluginWorkbench).toBe(metadata);
    expect(metadata.context).toBe(context);
    expect(metadata.context).toEqual({ workbenchId: "existing-session", retained: { value: 1 } });
    expect(metadata.commandId).toBe(source ?? "open");
    expect(shortcuts.isActive(entry)).toBe(source !== "other");
    expect(shortcuts.isActive(other)).toBe(source === "other");
    // Another command sharing this workbench must not steal its provenance.
    shortcuts.open(other);
    expect(query.tabs).toHaveLength(1);
    expect(query.activeTabId).toBe(oldId);
    expect(metadata.commandId).toBe(source ?? "open");
    expect(metadata.context).toBe(context);
    expect(shortcuts.isActive(entry)).toBe(source !== "other");
    expect(shortcuts.isActive(other)).toBe(source === "other");
  });
  it.each(["command", "connection"] as const)("highlights additional %s sessions only for their originating shortcut", async (kind) => {
    const plugin = fixture("a");
    (plugin.manifest.contributions[1] as any).action.instance_key = "local";
    mocks.list.mockResolvedValue([plugin]);
    await mount();
    const entry = shortcuts.entries.value[0];
    shortcuts.open(entry);
    const secondId = addPluginDockEntry({ pluginId: entry.pluginId, commandId: entry.targetId, instanceKey: "local", workbenchContributionId: "workbench", kind, title: "Second session" });
    expect(shortcuts.isActive(entry)).toBe(true);
    shortcuts.open(entry);
    expect(shortcuts.isActive(entry)).toBe(false);
    shortcuts.open(entry);
    expect(shortcuts.isActive(entry)).toBe(true);
    expect(usePluginBottomDock().activeEntryId.value).toBe(secondId);
    expect(usePluginBottomDock().entries.value).toHaveLength(2);
    addPluginDockEntry({ pluginId: entry.pluginId, commandId: "another-command", instanceKey: "local", workbenchContributionId: "workbench", kind, title: "Other function" });
    expect(shortcuts.isActive(entry)).toBe(false);
  });
  it.each(["singleton", "new"])("restores the selected instance after hiding a command with multiple panels (reuse=%s)", async (reuse) => {
    const plugin = fixture("a");
    (plugin.manifest.contributions[1] as any).action.reuse = reuse;
    mocks.list.mockResolvedValue([plugin]);
    await mount();
    const entry = shortcuts.entries.value[0];
    shortcuts.open(entry);
    const secondId = addPluginDockEntry({ pluginId: entry.pluginId, commandId: entry.targetId, workbenchContributionId: "workbench", kind: "command", title: "Second terminal" });
    shortcuts.open(entry);
    expect(usePluginBottomDock().visible.value).toBe(false);
    shortcuts.open(entry);
    expect(usePluginBottomDock().activeEntryId.value).toBe(secondId);
    expect(usePluginBottomDock().entries.value).toHaveLength(2);
  });
  it("filters entire plugins without losing their saved order or running sessions", async () => {
    await mount();
    const [a, b] = shortcuts.entries.value;
    shortcuts.open(a);
    mocks.settings.editorSettings.pluginShortcuts.order = [b.id, a.id];
    mocks.settings.editorSettings.pluginShortcuts.hiddenPluginIds = ["a"];
    expect(shortcuts.entries.value.map((entry) => entry.id)).toEqual([b.id]);
    expect(shortcuts.allEntries.value.map((entry) => entry.id)).toEqual([b.id, a.id]);
    expect(usePluginBottomDock().entries.value).toHaveLength(1);
    mocks.settings.editorSettings.pluginShortcuts.hiddenPluginIds = [];
    expect(shortcuts.entries.value.map((entry) => entry.id)).toEqual([b.id, a.id]);
  });
  it("toggles only the matching panel, preserves sessions and restores the correct command", async () => {
    await mount();
    const [a, b] = shortcuts.entries.value;
    const dock = usePluginBottomDock();
    shortcuts.open(a);
    const firstId = dock.activeEntryId.value;
    shortcuts.open(b);
    expect(dock.entries.value).toHaveLength(2);
    expect(shortcuts.isActive(a)).toBe(false);
    expect(shortcuts.isActive(b)).toBe(true);
    shortcuts.open(a);
    expect(dock.activeEntryId.value).toBe(firstId);
    expect(dock.visible.value).toBe(true);
    shortcuts.open(a);
    expect(dock.visible.value).toBe(false);
    expect(dock.entries.value).toHaveLength(2);
    shortcuts.open(a);
    expect(dock.entries.value).toHaveLength(2);
    expect(dock.activeEntryId.value).toBe(firstId);
  });
  it("opens tab commands and legacy workbenches/filesystems with their proper context", async () => {
    const legacy = fixture("legacy");
    legacy.manifest.contributions = [
      { type: "workbench", id: "workbench", label: "Workbench" },
      { type: "filesystem-provider", id: "files", label: "Files", schemes: ["file"], root_uri: "file:///" },
    ] as any;
    mocks.list.mockResolvedValue([fixture("tab", "tab"), legacy]);
    await mount();
    for (const entry of shortcuts.entries.value) shortcuts.open(entry);
    expect(mocks.query.openPluginWorkbench).toHaveBeenCalledWith("tab", "workbench", expect.objectContaining({ commandId: "open", forceNew: false, context: expect.objectContaining({ surface: "tab" }) }));
    expect(mocks.query.openPluginWorkbench).toHaveBeenCalledWith("legacy", "workbench", { title: "Workbench" });
    expect(mocks.query.openPluginFilesystem).toHaveBeenCalledWith("legacy", "files", { title: "Files", rootUri: "file:///" });
  });
  it("refreshes on uninstall and locale changes and refuses stale entries", async () => {
    await mount();
    const old = shortcuts.entries.value[0];
    mocks.list.mockResolvedValue([fixture("b")]);
    window.dispatchEvent(new Event("dbx:plugins-changed"));
    await vi.waitFor(() => expect(shortcuts.entries.value).toHaveLength(1));
    shortcuts.open(old);
    expect(usePluginBottomDock().entries.value).toHaveLength(0);
    mocks.locale.value = "zh-CN";
    await vi.waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
    app.unmount();
    window.dispatchEvent(new Event("dbx:plugins-changed"));
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });
});
