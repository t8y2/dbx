// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch, findOne, mountComponent } from "@/components/grid/__tests__/vueHostHarness";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${JSON.stringify(values)}` : ""}`,
  }),
}));

vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { ChevronDown: icon, ChevronRight: icon, Database: icon, Folder: icon, Search: icon };
});

vi.mock("@/components/ui/badge", async () => ({ Badge: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Badge", "span") }));
vi.mock("@/components/ui/button", async () => ({ Button: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/input", async () => ({ Input: (await import("@/components/grid/__tests__/vueHostHarness")).createPassthroughStub("Input", "input") }));

import McpResourceScopePicker from "@/components/settings/McpResourceScopePicker.vue";

function connection(id: string): ConnectionConfig {
  return {
    id,
    name: `${id}-name`,
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "test",
    password: "",
  };
}

const layout: SidebarLayout = {
  groups: [{ id: "g1", name: "Group 1", collapsed: false }],
  order: [
    { type: "group", id: "g1", children: [{ type: "connection", id: "c1" }] },
    { type: "connection", id: "c2" },
  ],
};

const connections = [connection("c1"), connection("c2")];

function mountPicker(props: Record<string, unknown> = {}) {
  const update = vi.fn();
  const mounted = mountComponent(McpResourceScopePicker, {
    layout,
    connections,
    allowedGroupIds: [],
    allowedConnectionIds: [],
    "onUpdate:scope": update,
    ...props,
  });
  return { mounted, update };
}

function modeButton(root: ReturnType<typeof mountComponent>["root"], mode: "all" | "custom") {
  return findOne(root, (node) => node.type === "button" && node.props["data-scope-mode"] === mode);
}

describe("McpResourceScopePicker", () => {
  let confirmMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits allow-all when switching from a custom group and connection selection", () => {
    const { mounted, update } = mountPicker({
      allowedGroupIds: ["g1"],
      allowedConnectionIds: ["c2"],
    });

    dispatch(modeButton(mounted.root, "all"), "click");

    expect(update).toHaveBeenCalledWith({ allowedGroupIds: [], allowedConnectionIds: null });
  });

  it("restores the previous custom selection after switching to all connections and back", async () => {
    const customScope = { allowedGroupIds: ["g1"], allowedConnectionIds: ["c2"] };
    const { mounted, update } = mountPicker(customScope);

    dispatch(modeButton(mounted.root, "all"), "click");
    expect(confirmMock).toHaveBeenCalledWith("settings.mcpResourceScopeAllConfirm");
    await mounted.setProps({ allowedGroupIds: [], allowedConnectionIds: null });
    dispatch(modeButton(mounted.root, "custom"), "click");

    expect(update).toHaveBeenLastCalledWith(customScope);
  });

  it("keeps the custom scope without emitting when the all-connections confirm is cancelled", () => {
    confirmMock.mockReturnValue(false);
    const { mounted, update } = mountPicker({
      allowedGroupIds: ["g1"],
      allowedConnectionIds: ["c2"],
    });

    dispatch(modeButton(mounted.root, "all"), "click");

    expect(confirmMock).toHaveBeenCalledWith("settings.mcpResourceScopeAllConfirm");
    expect(modeButton(mounted.root, "all").props["aria-checked"]).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("starts custom scope empty when there is no previous custom snapshot", () => {
    const { mounted, update } = mountPicker({
      allowedGroupIds: [],
      allowedConnectionIds: null,
    });

    dispatch(modeButton(mounted.root, "custom"), "click");

    expect(update).toHaveBeenCalledWith({ allowedGroupIds: [], allowedConnectionIds: [] });
  });

  it("restores an empty custom selection after switching away from it", async () => {
    const { mounted, update } = mountPicker({
      allowedGroupIds: [],
      allowedConnectionIds: [],
    });

    dispatch(modeButton(mounted.root, "all"), "click");
    expect(confirmMock).not.toHaveBeenCalled();
    await mounted.setProps({ allowedGroupIds: [], allowedConnectionIds: null });
    dispatch(modeButton(mounted.root, "custom"), "click");

    expect(update).toHaveBeenLastCalledWith({ allowedGroupIds: [], allowedConnectionIds: [] });
  });

  it("does not emit while disabled", () => {
    const { mounted, update } = mountPicker({
      allowedGroupIds: ["g1"],
      allowedConnectionIds: ["c2"],
      disabled: true,
    });

    dispatch(modeButton(mounted.root, "all"), "click");

    expect(update).not.toHaveBeenCalled();
  });

  it("does not emit while busy", () => {
    const { mounted, update } = mountPicker({
      allowedGroupIds: ["g1"],
      allowedConnectionIds: ["c2"],
      busy: true,
    });

    dispatch(modeButton(mounted.root, "all"), "click");

    expect(update).not.toHaveBeenCalled();
  });
});
