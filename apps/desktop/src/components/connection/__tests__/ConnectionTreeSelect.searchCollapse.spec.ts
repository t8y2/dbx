// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
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

async function mountPicker(extraConnections: ConnectionConfig[] = [], customTrigger = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const state = reactive({
    modelValue: "",
    connections: [...connections, ...extraConnections].map((connection) => ({ ...connection })),
  });
  const app = createApp({
    render: () =>
      h(
        ConnectionTreeSelect,
        {
          ...state,
          layout,
          placeholder: "Select connection",
          searchPlaceholder: "Search connections",
          emptyText: "No connections",
          "onUpdate:modelValue": (value: string) => (state.modelValue = value),
        },
        customTrigger ? { "trigger-label": ({ label }: { label: string }) => h("strong", label) } : undefined,
      ),
  });
  mountedApps.push(app);
  app.mount(container);
  await nextTick();
  return { container, state };
}

function cssBackgroundColor(color: string) {
  const element = document.createElement("span");
  element.style.backgroundColor = color;
  return element.style.backgroundColor;
}

async function setSearchText(value: string) {
  const input = document.body.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error("Search input was not rendered");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await nextTick();
}

function groupButton() {
  const button = document.body.querySelector('[data-picker-group="g1"]');
  if (!(button instanceof HTMLButtonElement)) throw new Error("Group button was not rendered");
  return button;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("ConnectionTreeSelect search collapse behavior", () => {
  it.each(["red", "hsl(0, 100%, 50%)", "#ff000080", "rgba(255, 0, 0, 0.5)"])("preserves custom CSS color %s in the row and selected trigger", async (color) => {
    const { container, state } = await mountPicker([{ ...connections[0], id: "custom", color }]);
    const row = container.querySelector<HTMLButtonElement>('[data-picker-connection="custom"]')!;
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    const expected = cssBackgroundColor(color);
    expect(expected).not.toBe("");

    row.click();
    await nextTick();
    expect(state.modelValue).toBe("custom");
    for (const element of [row, trigger]) {
      expect(element.querySelector<HTMLElement>("[data-connection-color]")?.style.backgroundColor).toBe(expected);
    }

    // Saving a connection replaces its config in the store instead of mutating it.
    state.connections = state.connections.map((connection) => (connection.id === "custom" ? { ...connection, color: undefined } : connection));
    await nextTick();
    for (const element of [row, trigger]) {
      expect(element.querySelector("[data-connection-color]")).toBeNull();
      expect(element.classList.contains("dbx-connection-picker-colored")).toBe(false);
      expect(element.style.getPropertyValue("--connection-picker-background")).toBe("");
    }
  });

  it.each([false, true])("syncs configured colors while switching and editing connections (custom trigger: %s)", async (customTrigger) => {
    const { container, state } = await mountPicker(
      [
        { ...connections[0], id: "prod", name: "Production DB", color: "#ef4444" },
        { ...connections[0], id: "test", name: "Test DB", color: "#22c55e" },
      ],
      customTrigger,
    );
    const row = (id: string) => container.querySelector<HTMLButtonElement>(`[data-picker-connection="${id}"]`)!;
    const marker = (element: Element) => element.querySelector<HTMLElement>("[data-connection-color]");
    const trigger = container.querySelector<HTMLButtonElement>("button")!;

    expect(marker(trigger)).toBeNull();
    expect(marker(row("c1"))).toBeNull();
    expect(marker(row("prod"))?.style.backgroundColor).toBe(cssBackgroundColor("#ef4444"));
    expect(marker(row("test"))?.style.backgroundColor).toBe(cssBackgroundColor("#22c55e"));

    row("prod").click();
    await nextTick();
    expect(state.modelValue).toBe("prod");
    expect(marker(trigger)?.style.backgroundColor).toBe(cssBackgroundColor("#ef4444"));
    expect(trigger.textContent).toContain("Production DB");

    state.connections.find((connection) => connection.id === "prod")!.color = "#abc";
    await nextTick();
    expect(marker(trigger)?.style.backgroundColor).toBe(cssBackgroundColor("#abc"));
    expect(marker(row("prod"))?.style.backgroundColor).toBe(cssBackgroundColor("#abc"));

    row("test").click();
    await nextTick();
    expect(marker(trigger)?.style.backgroundColor).toBe(cssBackgroundColor("#22c55e"));
    state.connections.find((connection) => connection.id === "test")!.color = "";
    await nextTick();
    expect(marker(trigger)).toBeNull();
    expect(marker(row("test"))).toBeNull();
    expect(trigger.style.getPropertyValue("--connection-picker-background")).toBe("");

    state.modelValue = "missing";
    await nextTick();
    expect(marker(trigger)).toBeNull();
  });

  it("passes plugin identity and provider logo metadata to the shared icon", async () => {
    await mountPicker([{ ...connections[0], id: "plugin", name: "Plugin", db_type: "plugin", plugin_id: "sample.plugin", plugin_connection_provider: "sample.connection" }]);
    const icon = document.body.querySelector('[data-picker-connection="plugin"] [data-plugin-id]');
    expect(icon?.getAttribute("data-plugin-id")).toBe("sample.plugin");
    expect(icon?.getAttribute("data-contribution-id")).toBe("sample.connection");
  });

  it("ignores group clicks during search without changing the post-search state", async () => {
    await mountPicker();
    await setSearchText("Primary");

    expect(groupButton().disabled).toBe(true);
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");

    groupButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    await setSearchText("");

    expect(groupButton().disabled).toBe(false);
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('[data-picker-connection="c1"]')).not.toBeNull();
  });

  it("preserves group collapsing when search is inactive", async () => {
    await mountPicker();

    groupButton().click();
    await nextTick();
    expect(groupButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[data-picker-connection="c1"]')).toBeNull();

    groupButton().click();
    await nextTick();
    expect(groupButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('[data-picker-connection="c1"]')).not.toBeNull();
  });
});
