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

async function mountPicker() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(ConnectionTreeSelect, {
    modelValue: "",
    connections,
    layout,
    placeholder: "Select connection",
    searchPlaceholder: "Search connections",
    emptyText: "No connections",
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
