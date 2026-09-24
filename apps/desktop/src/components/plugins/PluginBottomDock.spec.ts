// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@/types/database";

const mocks = vi.hoisted(() => ({ listPlugins: vi.fn() }));

vi.mock("@/lib/backend/api", () => ({ listPlugins: mocks.listPlugins }));
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
    setup(props) {
      return () => h("div", { "data-workbench-host-stub": "" }, `${props.plugin.manifest.name} · ${props.contribution.label}`);
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
