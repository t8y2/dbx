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

function mountPicker() {
  const editorInput = document.createElement("textarea");
  const container = document.createElement("div");
  document.body.append(editorInput, container);
  const app = createApp(ConnectionTreeSelect, {
    modelValue: "",
    connections,
    layout,
    placeholder: "Select connection",
    searchPlaceholder: "Search connections",
    emptyText: "No connections",
  });
  mountedApps.push(app);
  const instance = app.mount(container) as unknown as { openDropdown: () => boolean };
  return { editorInput, instance };
}

function searchInput() {
  const input = document.body.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error("Search input was not rendered");
  return input;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("ConnectionTreeSelect shortcut focus restore", () => {
  it("returns focus to the element focused before openDropdown once the picker closes", async () => {
    const { editorInput, instance } = mountPicker();

    editorInput.focus();
    expect(document.activeElement).toBe(editorInput);
    expect(instance.openDropdown()).toBe(true);
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(searchInput());

    searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();

    expect(document.activeElement).toBe(editorInput);
  });

  it("skips the focus restore when the captured element left the document before close", async () => {
    const { editorInput, instance } = mountPicker();

    editorInput.focus();
    expect(instance.openDropdown()).toBe(true);
    await nextTick();

    editorInput.remove();
    searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();

    expect(document.activeElement).not.toBe(editorInput);
  });
});
