// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@/types/database";

const mocks = vi.hoisted(() => ({ listPlugins: vi.fn(), invokePlugin: vi.fn() }));

vi.mock("@/lib/backend/api", () => ({ listPlugins: mocks.listPlugins, invokePlugin: mocks.invokePlugin }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ locale: ref("en"), t: (key: string) => key }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [] }) }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/components/ui/button", () => ({
  Button: defineComponent(
    (_, { slots }) =>
      () =>
        h("button", slots.default?.()),
  ),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: defineComponent(
    (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  ),
  TooltipTrigger: defineComponent(
    (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  ),
  TooltipContent: defineComponent(
    (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  ),
}));
vi.mock("./PluginIcon.vue", () => ({ default: defineComponent(() => () => h("span")) }));
// Mirrors the real PluginWorkbenchHost, whose title computed dereferences
// props.contribution.label unconditionally — an undefined contribution must
// never reach it, otherwise the whole dock subtree crashes during render.
vi.mock("./PluginWorkbenchHost.vue", () => ({
  default: defineComponent({
    props: {
      plugin: { type: Object, required: true },
      contribution: { type: Object, required: true },
      context: { type: Object, default: undefined },
    },
    emits: ["open-workbench"],
    setup(props, { emit }) {
      return () => h("div", { "data-workbench-host-stub": "", onClick: () => emit("open-workbench", props.contribution.id, { commandId: "untrusted" }) }, `${props.plugin.manifest.name} · ${props.contribution.label}`);
    },
  }),
}));

import PluginBottomDock from "./PluginBottomDock.vue";
import * as dock from "@/lib/plugins/pluginBottomDock";

function installedPlugin(contributionId: string): InstalledPlugin {
  return {
    manifest: { id: "io.dbx.sample", name: "Sample", version: "1.0.0", permissions: [], drivers: [], contributions: [{ type: "workbench", id: contributionId, label: "Sample panel" }] },
    compatibility: { compatible: true },
  };
}

describe("PluginBottomDock workbench contribution guard", () => {
  let app: App<Element> | undefined;
  let root: HTMLDivElement;
  let renderError: unknown;
  const entryIds: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    app?.unmount();
    root.remove();
    for (const id of entryIds.splice(0)) dock.closePluginDockEntry(id);
    dock.setDockVisible(false);
  });

  async function mountDock() {
    dock.setDockVisible(true);
    const application = createApp(PluginBottomDock);
    renderError = undefined;
    application.config.errorHandler = (error) => {
      renderError = error;
    };
    app = application;
    application.mount(root);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("renders the workbench host when the entry's contribution is still live", async () => {
    mocks.listPlugins.mockResolvedValue([installedPlugin("sample.panel")]);
    entryIds.push(dock.addPluginDockEntry({ pluginId: "io.dbx.sample", workbenchContributionId: "sample.panel", kind: "command", commandId: "sample.open", title: "Sample terminal" }));

    await mountDock();

    expect(renderError).toBeUndefined();
    expect(root.querySelector("[data-workbench-host-stub]")?.textContent).toBe("Sample · Sample panel");
  });

  it("preserves host command provenance when a plugin opens a second session", async () => {
    mocks.listPlugins.mockResolvedValue([installedPlugin("sample.panel")]);
    const first = dock.addPluginDockEntry({ pluginId: "io.dbx.sample", workbenchContributionId: "sample.panel", kind: "command", commandId: "sample.open", instanceKey: "local", icon: "terminal", title: "Terminal" });
    entryIds.push(first);
    await mountDock();
    (root.querySelector("[data-workbench-host-stub]") as HTMLElement).click();
    const state = dock.usePluginBottomDock();
    const second = state.entries.value.find((entry) => entry.id === state.activeEntryId.value)!;
    entryIds.push(second.id);
    expect(second.id).not.toBe(first);
    expect(second).toMatchObject({ commandId: "sample.open", instanceKey: "local", icon: "terminal" });
  });

  it("skips the launch options fetch when the panel command has no options_action", async () => {
    // options_action is optional on open-workbench panel commands; without the
    // guard the dock still fired a doomed invokePlugin(undefined) round trip
    // and warned on every picker open / entry switch.
    const plugin = installedPlugin("sample.panel");
    plugin.manifest.contributions!.push({
      type: "command",
      id: "sample.open",
      label: "Open sample",
      action: { type: "open-workbench", workbench: "sample.panel", presentation: "panel" },
    });
    mocks.listPlugins.mockResolvedValue([plugin]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      entryIds.push(dock.addPluginDockEntry({ pluginId: "io.dbx.sample", workbenchContributionId: "sample.panel", kind: "command", commandId: "sample.open", title: "Sample terminal" }));
      await mountDock();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(renderError).toBeUndefined();
      expect(mocks.invokePlugin).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls.filter((call) => String(call[0]).includes("[DBX][plugin:dock]"))).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("degrades to an empty frame instead of crashing when the plugin no longer declares the entry's workbench contribution", async () => {
    // Plugin upgrade/downgrade replaced the workbench id the entry was opened with.
    mocks.listPlugins.mockResolvedValue([installedPlugin("sample.renamed")]);
    entryIds.push(dock.addPluginDockEntry({ pluginId: "io.dbx.sample", workbenchContributionId: "sample.panel", kind: "command", commandId: "sample.open", title: "Sample terminal" }));

    await mountDock();

    expect(renderError).toBeUndefined();
    expect(root.querySelector("[data-workbench-host-stub]")).toBeNull();
    // The tab strip (and its close affordance) survives so the stale entry stays closable.
    expect(root.querySelector("[data-plugin-dock-tabs]")?.textContent).toContain("Sample terminal");
  });
});
