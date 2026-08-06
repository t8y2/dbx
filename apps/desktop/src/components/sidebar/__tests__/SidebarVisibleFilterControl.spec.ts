// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import SidebarVisibleFilterControl from "@/components/sidebar/SidebarVisibleFilterControl.vue";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHost } from "@/lib/sidebar/sidebarTreeRuntime";
import type { SidebarVisibleFilterSummary } from "@/lib/sidebar/sidebarVisibleFilterSummary";
import type { ConnectionConfig, TreeNode } from "@/types/database";

const state: {
  config: Pick<ConnectionConfig, "db_type" | "name">;
  summary: SidebarVisibleFilterSummary;
} = {
  config: { db_type: "mysql", name: "MySQL" },
  summary: { mode: "database", isActive: true, selected: 1, total: 6 },
};

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => state.config,
    getSidebarVisibleFilterSummary: () => state.summary,
  }),
}));

const mountedApps: App[] = [];

function runtimeHost(): SidebarTreeRuntimeHost {
  return {
    buildContextMenu: vi.fn(() => []),
    handleRowClick: vi.fn(),
    handleRowDoubleClick: vi.fn(),
    handleRowKeydown: vi.fn(),
    openPrimaryVisibleFilter: vi.fn(),
    openDataInNewTab: vi.fn(),
    requestPaste: vi.fn(() => false),
    toggleNode: vi.fn(),
  };
}

async function mountControl() {
  const node: TreeNode = { id: "connection-1", label: "MySQL", type: "connection", connectionId: "connection-1" };
  const container = document.createElement("div");
  document.body.append(container);
  const runtime = createSidebarTreeRuntime();
  const host = runtimeHost();
  runtime.bindHost(host);
  const app = createApp(
    defineComponent({
      setup: () => () => h(SidebarVisibleFilterControl, { node }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.provide(sidebarTreeRuntimeKey, runtime);
  app.mount(container);
  await nextTick();
  return { container, host, node };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  state.config = { db_type: "mysql", name: "MySQL" };
  state.summary = { mode: "database", isActive: true, selected: 1, total: 6 };
});

describe("SidebarVisibleFilterControl", () => {
  it("reveals the active selected/total count on row hover or focus and opens the existing primary filter route", async () => {
    const { container, host, node } = await mountControl();
    const button = container.querySelector<HTMLButtonElement>("[data-sidebar-visible-filter]");

    expect(button?.textContent).toBe("1/6");
    expect(button?.getAttribute("aria-label")).toContain("MySQL");
    expect(button?.classList.contains("opacity-0")).toBe(true);
    expect(button?.classList.contains("group-hover/sidebar-row:opacity-100")).toBe(true);
    expect(button?.classList.contains("group-focus-within/sidebar-row:opacity-100")).toBe(true);
    button?.click();
    expect(host.openPrimaryVisibleFilter).toHaveBeenCalledWith(node);
  });

  it("does not render before counts are available", async () => {
    state.summary = { mode: "database", isActive: false, selected: null, total: null };
    const { container } = await mountControl();
    const button = container.querySelector<HTMLButtonElement>("[data-sidebar-visible-filter]");

    expect(button).toBeNull();
  });

  it("does not render for an explicit full selection", async () => {
    state.summary = { mode: "database", isActive: false, selected: 6, total: 6 };
    const { container } = await mountControl();
    const button = container.querySelector<HTMLButtonElement>("[data-sidebar-visible-filter]");

    expect(button).toBeNull();
  });

  it("does not render an explicit filter until metadata resolves its effective state", async () => {
    state.summary = { mode: "database", isActive: false, selected: null, total: null };
    const { container } = await mountControl();
    const button = container.querySelector<HTMLButtonElement>("[data-sidebar-visible-filter]");

    expect(button).toBeNull();
  });

  it("does not render for unsupported connection types", async () => {
    state.config = { db_type: "elasticsearch", name: "Search" };
    const { container } = await mountControl();

    expect(container.querySelector("[data-sidebar-visible-filter]")).toBeNull();
  });
});
