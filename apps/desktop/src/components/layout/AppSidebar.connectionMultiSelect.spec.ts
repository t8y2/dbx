// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, reactive } from "vue";

const mocks = vi.hoisted(() => ({
  store: null as any,
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => mocks.store,
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      props: { disabled: Boolean },
      setup(props, { attrs, slots }) {
        return () => h("button", { ...attrs, disabled: props.disabled }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup(_, { slots }) {
        return () => h("div", { [`data-${name.toLowerCase()}`]: "" }, slots.default?.());
      },
    });
  return {
    Dialog: defineComponent({
      props: { open: Boolean },
      emits: ["update:open"],
      setup(props, { slots }) {
        return () => (props.open ? h("div", { "data-dialog": "" }, slots.default?.()) : null);
      },
    }),
    DialogContent: passthrough("DialogContent"),
    DialogFooter: passthrough("DialogFooter"),
    DialogHeader: passthrough("DialogHeader"),
    DialogTitle: passthrough("DialogTitle"),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      inheritAttrs: false,
      props: { modelValue: { type: String, default: "" } },
      emits: ["update:modelValue"],
      setup(props, { attrs, emit }) {
        return () =>
          h("input", {
            ...attrs,
            value: props.modelValue,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          });
      },
    }),
  };
});

vi.mock("@/components/ui/LightTooltip.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { text: { type: String, default: "" } },
      setup(props, { slots }) {
        return () => h("span", { "data-tooltip": props.text }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/LightDropdown.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: {
        items: { type: Array, default: () => [] },
        ariaLabel: { type: String, default: "" },
      },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h(
            "div",
            { "data-dropdown": props.ariaLabel },
            (props.items as Array<{ value?: string; val?: string; label: string }>).map((item) => {
              const value = item.value ?? item.val ?? "";
              return h("button", { "data-dropdown-value": value, onClick: () => emit("update:modelValue", value) }, item.label);
            }),
          );
      },
    }),
  };
});

vi.mock("@/components/sidebar/ConnectionTree.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      setup(_, { expose }) {
        expose({
          createNewGroup: vi.fn(),
          collapseAllTreeNodes: vi.fn(),
          focusSearch: vi.fn(() => false),
        });
        return () => h("div", { "data-connection-tree": "" });
      },
    }),
  };
});

import AppSidebar from "@/components/layout/AppSidebar.vue";

const mountedApps: Array<{ unmount: () => void; host: HTMLElement }> = [];

function createStore() {
  return reactive({
    connections: [{ id: "conn-visible" }, { id: "conn-hidden" }, { id: "conn-next" }],
    sidebarLayout: { groups: [{ id: "group-a", name: "Group A" }] },
    selectedTreeNodeIds: [] as string[],
    selectedTreeNodeId: null as string | null,
    treeSelectionAnchorId: null as string | null,
    connectionMultiSelectActive: false,
    moveConnectionToGroup: vi.fn(),
    createConnectionGroup: vi.fn(() => "group-new"),
    refreshAllTree: vi.fn().mockResolvedValue(undefined),
    removeConnections: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  });
}

function setSelection(connectionIds: string[]) {
  const lastConnectionId = connectionIds[connectionIds.length - 1] ?? null;
  mocks.store.selectedTreeNodeIds = [...connectionIds];
  mocks.store.selectedTreeNodeId = lastConnectionId;
  mocks.store.treeSelectionAnchorId = lastConnectionId;
  mocks.store.connectionMultiSelectActive = connectionIds.length > 0;
}

function click(element: Element | null) {
  expect(element).not.toBeNull();
  element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function mountSidebar() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(
    defineComponent({
      setup: () => () => h(AppSidebar, { sidebarWidth: 260 }),
    }),
  );
  app.mount(host);
  mountedApps.push({ unmount: () => app.unmount(), host });
  await nextTick();
  return host;
}

describe("AppSidebar connection multi-select moves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store = createStore();
  });

  afterEach(() => {
    for (const mounted of mountedApps.splice(0)) {
      mounted.unmount();
      mounted.host.remove();
    }
  });

  it("releases an existing-group batch including filtered connections before the next batch", async () => {
    setSelection(["conn-visible", "conn-hidden"]);
    const host = await mountSidebar();

    click(host.querySelector('[data-dropdown="connectionGroup.moveToGroup"] [data-dropdown-value="group-a"]'));
    await nextTick();

    expect(mocks.store.moveConnectionToGroup.mock.calls).toEqual([
      ["conn-visible", "group-a"],
      ["conn-hidden", "group-a"],
    ]);
    expect(mocks.store.selectedTreeNodeIds).toEqual([]);
    expect(mocks.store.connectionMultiSelectActive).toBe(false);

    setSelection(["conn-next"]);
    await nextTick();
    click(host.querySelector('[data-dropdown="connectionGroup.moveToGroup"] [data-dropdown-value="group-a"]'));
    await nextTick();

    expect(mocks.store.moveConnectionToGroup.mock.calls[mocks.store.moveConnectionToGroup.mock.calls.length - 1]).toEqual(["conn-next", "group-a"]);
    expect(mocks.store.moveConnectionToGroup).toHaveBeenCalledTimes(3);
    expect(mocks.store.selectedTreeNodeIds).toEqual([]);
  });

  it("shows the selected count beside the connection title instead of as a toolbar item", async () => {
    setSelection(["conn-visible", "conn-hidden"]);
    const host = await mountSidebar();

    const count = host.querySelector("[data-connection-selection-count]");
    expect(count?.textContent?.trim()).toBe("connectionGroup.selectedConnections");
    expect(count?.previousElementSibling?.textContent?.trim()).toBe("sidebar.connections");
  });

  it("exits connection multi-select when Escape is pressed in the sidebar", async () => {
    setSelection(["conn-visible", "conn-hidden"]);
    const host = await mountSidebar();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

    host.querySelector<HTMLElement>(".app-sidebar-panel")!.dispatchEvent(event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(mocks.store.selectedTreeNodeIds).toEqual([]);
    expect(mocks.store.selectedTreeNodeId).toBeNull();
    expect(mocks.store.treeSelectionAnchorId).toBeNull();
    expect(mocks.store.connectionMultiSelectActive).toBe(false);
  });

  it("does not exit connection multi-select when Escape comes from an input", async () => {
    setSelection(["conn-visible", "conn-hidden"]);
    const host = await mountSidebar();
    click(host.querySelector('[data-tooltip="connectionGroup.createGroup"] button'));
    await nextTick();
    const input = host.querySelector<HTMLInputElement>("[data-dialog] input");

    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();

    expect(mocks.store.selectedTreeNodeIds).toEqual(["conn-visible", "conn-hidden"]);
    expect(mocks.store.connectionMultiSelectActive).toBe(true);
  });

  it("keeps selection on cancel and releases it after creating a new group", async () => {
    setSelection(["conn-visible", "conn-hidden"]);
    const host = await mountSidebar();

    click(host.querySelector('[data-tooltip="connectionGroup.createGroup"] button'));
    await nextTick();
    click(Array.from(host.querySelectorAll("[data-dialog] button")).find((button) => button.textContent === "dangerDialog.cancel") ?? null);
    await nextTick();

    expect(mocks.store.createConnectionGroup).not.toHaveBeenCalled();
    expect(mocks.store.moveConnectionToGroup).not.toHaveBeenCalled();
    expect(mocks.store.selectedTreeNodeIds).toEqual(["conn-visible", "conn-hidden"]);

    click(host.querySelector('[data-tooltip="connectionGroup.createGroup"] button'));
    await nextTick();
    const input = host.querySelector<HTMLInputElement>("[data-dialog] input");
    expect(input).not.toBeNull();
    input!.value = "New group";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    click(Array.from(host.querySelectorAll("[data-dialog] button")).find((button) => button.textContent === "connectionGroup.createGroup") ?? null);
    await nextTick();

    expect(mocks.store.createConnectionGroup).toHaveBeenCalledWith("New group");
    expect(mocks.store.moveConnectionToGroup.mock.calls).toEqual([
      ["conn-visible", "group-new"],
      ["conn-hidden", "group-new"],
    ]);
    expect(mocks.store.selectedTreeNodeIds).toEqual([]);
    expect(mocks.store.connectionMultiSelectActive).toBe(false);
  });

  it("releases a batch moved to ungrouped", async () => {
    setSelection(["conn-visible", "conn-hidden"]);
    const host = await mountSidebar();

    click(host.querySelector('[data-dropdown="connectionGroup.moveToGroup"] [data-dropdown-value="__ungrouped"]'));
    await nextTick();

    expect(mocks.store.moveConnectionToGroup.mock.calls).toEqual([
      ["conn-visible", null],
      ["conn-hidden", null],
    ]);
    expect(mocks.store.selectedTreeNodeIds).toEqual([]);
    expect(mocks.store.connectionMultiSelectActive).toBe(false);
  });
});
