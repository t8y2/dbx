// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@/types/database";

const { listPlugins } = vi.hoisted(() => ({ listPlugins: vi.fn() }));

vi.mock("@/lib/backend/api", () => ({ listPlugins }));

import QueryResultToolbarActions from "../QueryResultToolbarActions.vue";

function installedPlugin(id: string, contributions: InstalledPlugin["manifest"]["contributions"]): InstalledPlugin {
  return {
    compatibility: { compatible: true },
    manifest: { id, name: id, version: "1.0.0", drivers: [], contributions },
  };
}

function resultViewPlugin(id: string, contributionId: string, label: string): InstalledPlugin {
  return installedPlugin(id, [{ type: "result-view", id: contributionId, label }]);
}

const mountedApps: Array<{ app: App<Element>; host: HTMLDivElement }> = [];

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

async function mountToolbar() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(QueryResultToolbarActions, {
    activeView: "result",
    canShowExplain: false,
    canShowProfile: false,
    canExportArchive: false,
    archiveExporting: false,
    hasResult: true,
  });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mountedApps.push({ app, host });
  await flush();
  return { host, app };
}

function visibleLabels(host: HTMLDivElement): string[] {
  return [...host.querySelectorAll("button span")].map((node) => node.textContent?.trim() ?? "").filter(Boolean);
}

describe("QueryResultToolbarActions plugin contribution refresh", () => {
  beforeEach(() => {
    listPlugins.mockReset();
    listPlugins.mockResolvedValue([]);
  });

  afterEach(() => {
    for (const { app, host } of mountedApps.splice(0)) {
      app.unmount();
      host.remove();
    }
  });

  it("renders a result-view contribution installed after mount once dbx:plugins-changed fires", async () => {
    const { host } = await mountToolbar();
    expect(visibleLabels(host)).not.toContain("Open graph");

    listPlugins.mockResolvedValue([resultViewPlugin("com.example.chart", "result.graph", "Open graph")]);
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await flush();

    expect(visibleLabels(host)).toContain("Open graph");
    expect(listPlugins).toHaveBeenCalledTimes(2);
  });

  it("drops the contribution when the plugin set becomes empty again", async () => {
    listPlugins.mockResolvedValue([resultViewPlugin("com.example.chart", "result.graph", "Open graph")]);
    const { host } = await mountToolbar();
    expect(visibleLabels(host)).toContain("Open graph");

    listPlugins.mockResolvedValue([]);
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await flush();

    expect(visibleLabels(host)).not.toContain("Open graph");
  });

  it("ignores plugins that are not compatible with the current host", async () => {
    const incompatible = { ...resultViewPlugin("com.example.legacy", "result.legacy", "Legacy view"), compatibility: { compatible: false } };
    listPlugins.mockResolvedValue([incompatible]);
    const { host } = await mountToolbar();

    expect(visibleLabels(host)).not.toContain("Legacy view");
  });

  it("stops refreshing after the toolbar is unmounted", async () => {
    const { host, app } = await mountToolbar();
    expect(listPlugins).toHaveBeenCalledTimes(1);

    app.unmount();
    host.remove();
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await flush();

    expect(listPlugins).toHaveBeenCalledTimes(1);
  });

  it("removes every listener on unmount instead of stacking them across mounts", async () => {
    const first = await mountToolbar();
    first.app.unmount();
    first.host.remove();

    const second = await mountToolbar();
    expect(listPlugins).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await flush();

    expect(listPlugins).toHaveBeenCalledTimes(3);
    second.app.unmount();
    second.host.remove();
  });
});
