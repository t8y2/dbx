// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConnectionTreeSelect from "@/components/connection/ConnectionTreeSelect.vue";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

vi.mock("@/components/ui/button", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return { Button: createPassthroughStub("Button", "button") };
});

vi.mock("@/components/ui/popover", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    Popover: createPassthroughStub("Popover"),
    PopoverContent: createPassthroughStub("PopoverContent"),
    PopoverTrigger: createPassthroughStub("PopoverTrigger"),
  };
});

vi.mock("@/components/icons/DatabaseIcon.vue", () => ({
  default: defineComponent({
    name: "DatabaseIconStub",
    setup: () => () => h("span"),
  }),
}));

vi.mock("@/components/plugins/PluginIcon.vue", () => ({
  default: defineComponent({
    props: ["pluginId", "contributionId"],
    setup: (props) => () => h("span", { "data-plugin-id": props.pluginId, "data-contribution-id": props.contributionId }),
  }),
}));

const mountedApps: App[] = [];

const connections: ConnectionConfig[] = [
  {
    id: "c1",
    name: "Primary",
    db_type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    password: "",
  },
];

const layout: SidebarLayout = {
  groups: [{ id: "g1", name: "Production", collapsed: false }],
  order: [{ type: "group", id: "g1", children: [{ type: "connection", id: "c1" }] }],
};

const twoGroupLayout: SidebarLayout = {
  groups: [
    { id: "g1", name: "Production", collapsed: false },
    { id: "g2", name: "Staging", collapsed: false },
  ],
  order: [
    { type: "group", id: "g1", children: [{ type: "connection", id: "c1" }] },
    { type: "group", id: "g2", children: [{ type: "connection", id: "c2" }] },
  ],
};

const secondaryConnection: ConnectionConfig = { ...connections[0], id: "c2", name: "Secondary" };

async function mountPicker(extraConnections: ConnectionConfig[] = [], extraProps: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(ConnectionTreeSelect, {
    modelValue: "",
    connections: [...connections, ...extraConnections],
    layout,
    placeholder: "Select connection",
    searchPlaceholder: "Search connections",
    emptyText: "No connections",
    ...extraProps,
  });
  mountedApps.push(app);
  app.mount(container);
  await nextTick();
}

async function setSearchText(value: string) {
  const input = document.body.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error("Search input was not rendered");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await nextTick();
}

function groupButton(groupId = "g1") {
  const button = document.body.querySelector(`[data-picker-group="${groupId}"]`);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Group button ${groupId} was not rendered`);
  return button;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("ConnectionTreeSelect search collapse behavior", () => {
  it("passes plugin identity and provider logo metadata to the shared icon", async () => {
    await mountPicker([{ ...connections[0], id: "plugin", name: "Plugin", db_type: "plugin", plugin_id: "sample.plugin", plugin_connection_provider: "sample.connection" }]);
    const icon = document.body.querySelector('[data-picker-connection="plugin"] [data-plugin-id]');
    expect(icon?.getAttribute("data-plugin-id")).toBe("sample.plugin");
    expect(icon?.getAttribute("data-contribution-id")).toBe("sample.connection");
  });

  it("restores the collapsed state after clearing a search", async () => {
    await mountPicker();
    await setSearchText("Primary");

    expect(groupButton().disabled).toBe(true);
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");

    groupButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    await setSearchText("");

    expect(groupButton().disabled).toBe(false);
    expect(groupButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[data-picker-connection="c1"]')).toBeNull();
  });

  it("collapses every group when no connection is selected", async () => {
    await mountPicker([secondaryConnection], { layout: twoGroupLayout });

    expect(groupButton("g1").getAttribute("aria-expanded")).toBe("false");
    expect(groupButton("g2").getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[data-picker-connection="c1"]')).toBeNull();
    expect(document.body.querySelector('[data-picker-connection="c2"]')).toBeNull();
  });

  it("expands only the group holding the selected connection", async () => {
    await mountPicker([secondaryConnection], { layout: twoGroupLayout, modelValue: "c2" });

    expect(groupButton("g1").getAttribute("aria-expanded")).toBe("false");
    expect(groupButton("g2").getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('[data-picker-connection="c1"]')).toBeNull();
    expect(document.body.querySelector('[data-picker-connection="c2"]')).not.toBeNull();
  });

  it("expands every group holding a selected connection in multiple mode", async () => {
    await mountPicker([secondaryConnection], { layout: twoGroupLayout, multiple: true, selectedConnectionIds: ["c1", "c2"] });

    expect(groupButton("g1").getAttribute("aria-expanded")).toBe("true");
    expect(groupButton("g2").getAttribute("aria-expanded")).toBe("true");
  });

  it("preserves group collapsing when search is inactive", async () => {
    await mountPicker();

    expect(groupButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[data-picker-connection="c1"]')).toBeNull();

    groupButton().click();
    await nextTick();
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('[data-picker-connection="c1"]')).not.toBeNull();

    groupButton().click();
    await nextTick();
    expect(groupButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[data-picker-connection="c1"]')).toBeNull();
  });

  it("toggles connections without replacing the model in multiple mode", async () => {
    const toggled: string[] = [];
    const updated: string[] = [];
    await mountPicker([{ ...connections[0], id: "c2", name: "Secondary" }], {
      multiple: true,
      selectedConnectionIds: ["c1"],
      onToggleConnection: (connectionId: string) => toggled.push(connectionId),
      "onUpdate:modelValue": (connectionId: string) => updated.push(connectionId),
    });

    const button = document.body.querySelector('[data-picker-connection="c2"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error("Connection button was not rendered");
    button.click();
    await nextTick();

    expect(toggled).toEqual(["c2"]);
    expect(updated).toEqual([]);
  });

  it("supports additional options alongside grouped connections", async () => {
    const updated: string[] = [];
    await mountPicker([], {
      extraOptions: [{ id: "all", label: "All connections" }],
      "onUpdate:modelValue": (value: string) => updated.push(value),
    });

    const button = document.body.querySelector('[data-picker-extra="all"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error("Extra option was not rendered");
    button.click();
    await nextTick();

    expect(updated).toEqual(["all"]);
  });
});
