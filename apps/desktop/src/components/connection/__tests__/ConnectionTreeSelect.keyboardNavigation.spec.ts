// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, ref, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConnectionTreeSelect from "../ConnectionTreeSelect.vue";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

// Keep the picker, search input, tree builder and keyboard handlers real.
// Replace overlay presentation so the tests do not depend on layout or animations.
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
vi.mock("@/components/icons/DatabaseIcon.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/plugins/PluginIcon.vue", () => ({ default: { template: "<span />" } }));

const mountedApps: App[] = [];

function connection(id: string): ConnectionConfig {
  return { id, name: `MySQL ${id.toUpperCase()}`, db_type: "mysql", host: "localhost", port: 3306, username: "root", password: "" };
}

async function settle() {
  await nextTick();
  await nextTick();
}

async function mountPicker(layout: SidebarLayout = { groups: [], order: [] }) {
  const state = reactive({ connections: [connection("a"), connection("b"), connection("c")], layout });
  const picker = ref<InstanceType<typeof ConnectionTreeSelect>>();
  const onSelect = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup: () => () =>
      h(ConnectionTreeSelect, {
        ref: picker,
        modelValue: "a",
        connections: state.connections,
        layout: state.layout,
        placeholder: "Select connection",
        searchPlaceholder: "Search connections",
        emptyText: "No connections",
        "onUpdate:modelValue": onSelect,
      }),
  });
  mountedApps.push(app);
  app.mount(host);
  expect(picker.value?.openDropdown()).toBe(true);
  await settle();
  const input = host.querySelector<HTMLInputElement>("input")!;
  const search = async (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
  };
  const press = async (key: string) => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await settle();
  };
  const rowIds = () => [...host.querySelectorAll<HTMLButtonElement>("[data-picker-connection]")].map((row) => row.dataset.pickerConnection);
  return { state, host, input, onSelect, search, press, rowIds };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
});

describe("ConnectionTreeSelect keyboard selection during list changes", () => {
  it.each(["", "MySQL"])("keeps the highlighted connection when an earlier row disappears with search %j", async (query) => {
    const { state, input, onSelect, search, press, rowIds } = await mountPicker();
    await search(query);
    await press("ArrowDown");

    state.connections = state.connections.filter((item) => item.id !== "a");
    await settle();
    expect(rowIds()).toEqual(["b", "c"]);
    expect(document.activeElement).toBe(input);
    await press("Enter");

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  });

  it.each(["prepend", "reorder"])("keeps the highlighted connection after %s while searching", async (change) => {
    const { state, onSelect, search, press } = await mountPicker();
    await search("MySQL");
    await press("ArrowDown");

    state.connections = change === "prepend" ? [connection("d"), ...state.connections] : [state.connections[2]!, state.connections[0]!, state.connections[1]!];
    await settle();
    await press("Enter");

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  });

  it.each(["", "MySQL"])("requires a new keyboard choice when the highlighted connection disappears with search %j", async (query) => {
    const { state, onSelect, search, press, rowIds } = await mountPicker();
    await search(query);
    await press("ArrowDown");

    state.connections = state.connections.filter((item) => item.id !== "b");
    await settle();
    expect(rowIds()).toEqual(["a", "c"]);
    await press("Enter");
    expect(onSelect).not.toHaveBeenCalled();

    await press("ArrowUp");
    await press("Enter");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("c");
  });

  it("selects the first match when the user changes the search", async () => {
    const { onSelect, search, press, rowIds } = await mountPicker();
    await search("MySQL");
    await press("ArrowDown");

    await search("MySQL C");
    expect(rowIds()).toEqual(["c"]);
    await press("Enter");

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("c");
  });

  it("does not select another connection when its highlighted group is collapsed", async () => {
    const { host, onSelect, press, rowIds } = await mountPicker({
      groups: [{ id: "group", name: "Grouped", collapsed: false }],
      order: [
        {
          type: "group",
          id: "group",
          children: [
            { type: "connection", id: "a" },
            { type: "connection", id: "b" },
          ],
        },
        { type: "connection", id: "c" },
      ],
    });
    await press("ArrowDown");
    host.querySelector<HTMLButtonElement>('[data-picker-group="group"]')!.click();
    await settle();
    expect(rowIds()).toEqual(["c"]);
    await press("Enter");
    expect(onSelect).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>('[data-picker-group="group"]')!.click();
    await settle();
    expect(rowIds()).toEqual(["a", "b", "c"]);
    await press("ArrowDown");
    await press("Enter");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("a");
  });
});
