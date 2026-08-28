// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Component } from "vue";

function passthrough(tag: string): Component {
  return defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h(tag, attrs, slots.default?.());
    },
  });
}

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@lucide/vue", () => {
  const Icon = passthrough("span");
  return {
    Square: Icon,
    CheckSquare: Icon,
    MinusSquare: Icon,
    Search: Icon,
    ChevronRight: Icon,
  };
});
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    inheritAttrs: false,
    props: { items: { type: Array, default: () => [] } },
    setup(props, { attrs, slots }) {
      return () =>
        h(
          "div",
          attrs,
          // Keep the unit test deterministic while mirroring a viewport-sized
          // RecycleScroller pool instead of rendering every supplied item.
          props.items.slice(0, 50).map((item, index) => slots.default?.({ item, index, active: true })),
        );
    },
  }),
}));
vi.mock("@/components/ui/button", () => ({ Button: passthrough("button") }));

import ObjectSelectionTree from "../ObjectSelectionTree.vue";

type Kind = "TABLE" | "VIEW" | "FUNCTION" | "SEQUENCE";

interface TreeGroup {
  kind: Kind;
  label: string;
  items: string[];
}

const VIEWS: TreeGroup = { kind: "VIEW", label: "Views", items: ["v1", "v2", "v3"] };
const FUNCTIONS: TreeGroup = { kind: "FUNCTION", label: "Fns", items: ["f1", "f2"] };
const TABLES: TreeGroup = { kind: "TABLE", label: "Tables", items: ["t1", "t2"] };
const POSTGRES_FUNCTIONS: TreeGroup = {
  kind: "FUNCTION",
  label: "Fns",
  items: ["_st_beststride", "_st_coveredby", "box", "box2d"],
};
const POSTGRES_SEQUENCES: TreeGroup = { kind: "SEQUENCE", label: "Sequences", items: ["biz_banner_id_seq"] };
const LARGE_TABLES: TreeGroup = {
  kind: "TABLE",
  label: "Tables",
  items: Array.from({ length: 40_000 }, (_, index) => (index === 20_000 ? "customer_order_special" : `table_${String(index).padStart(5, "0")}`)),
};

function mountTree(init: { groups?: TreeGroup[]; disabledGroups?: Kind[]; disabledHints?: Record<string, string>; selection?: Record<string, string[]>; search?: string }) {
  const { groups = [VIEWS, FUNCTIONS], disabledGroups = [], disabledHints = {}, selection = {}, search = "" } = init;
  const state = reactive({ selection, search, groups });
  const Wrapper = defineComponent({
    setup() {
      return () =>
        h(ObjectSelectionTree, {
          groups: state.groups,
          disabledGroups,
          disabledHints,
          modelValue: state.selection,
          "onUpdate:modelValue": (v: Record<string, string[]>) => {
            state.selection = v;
          },
          search: state.search,
          "onUpdate:search": (v: string) => {
            state.search = v;
          },
        });
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createApp(Wrapper);
  app.mount(container);
  return { state, container, app };
}

function groupToggle(container: HTMLElement, index = 0): HTMLButtonElement {
  return container.querySelectorAll<HTMLButtonElement>('button[data-test="group-toggle"]')[index];
}

function expandGroup(container: HTMLElement, kind: string) {
  container.querySelector<HTMLButtonElement>(`[data-test="group-${kind}"] button[data-test="group-expand"]`)!.click();
}

function itemCheckbox(container: HTMLElement, kind: string, item: string): HTMLInputElement {
  return container.querySelector<HTMLInputElement>(`label[data-test="item-${kind}-${item}"] input`)!;
}

function toolbarButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes(label));
}

async function typeSearch(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>('input[data-test="search"]')!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await nextTick();
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("ObjectSelectionTree interaction", () => {
  it("renders group headers, items and the search input", async () => {
    const { container, app } = mountTree({});
    cleanup = () => app.unmount();
    expect(container.textContent).toContain("Views");
    expect(container.querySelector('label[data-test="item-VIEW-v1"]')).not.toBeNull();
    expect(container.querySelector('label[data-test="item-FUNCTION-f2"]')).not.toBeNull();
    expect(container.querySelector('input[data-test="search"]')).not.toBeNull();
  });

  it("does not render a large group until the user expands it", async () => {
    const { container, app } = mountTree({ groups: [LARGE_TABLES] });
    cleanup = () => app.unmount();

    expect(container.querySelector('[data-test="group-TABLE"]')).not.toBeNull();
    expect(container.querySelectorAll('label[data-test^="item-TABLE-"]')).toHaveLength(0);
  });

  it("keeps asynchronously loaded large groups collapsed", async () => {
    const { state, container, app } = mountTree({ groups: [] });
    cleanup = () => app.unmount();

    state.groups = [LARGE_TABLES];
    await nextTick();
    expect(container.querySelector('[data-test="group-TABLE"]')).not.toBeNull();
    expect(container.querySelectorAll('label[data-test^="item-TABLE-"]')).toHaveLength(0);
  });

  it("virtualizes expanded large groups while keeping the full selection model", async () => {
    const { state, container, app } = mountTree({ groups: [LARGE_TABLES] });
    cleanup = () => app.unmount();

    expandGroup(container, "TABLE");
    await nextTick();
    const renderedItems = container.querySelectorAll('label[data-test^="item-TABLE-"]');
    expect(renderedItems.length).toBeGreaterThan(0);
    expect(renderedItems.length).toBeLessThan(100);
    expect(container.querySelector('label[data-test="item-TABLE-table_00000"]')).not.toBeNull();
    expect(container.querySelector('label[data-test="item-TABLE-table_39999"]')).toBeNull();

    groupToggle(container).click();
    await nextTick();
    expect(state.selection.TABLE).toHaveLength(40_000);
    expect(container.querySelectorAll('label[data-test^="item-TABLE-"]').length).toBeLessThan(100);
  });

  it("reveals large-group search matches without rendering every result", async () => {
    const { container, app } = mountTree({ groups: [LARGE_TABLES] });
    cleanup = () => app.unmount();

    await typeSearch(container, "customer_order");
    expect(container.querySelector('label[data-test="item-TABLE-customer_order_special"]')).not.toBeNull();
    expect(container.querySelectorAll('label[data-test^="item-TABLE-"]')).toHaveLength(1);

    await typeSearch(container, "table_");
    expect(container.querySelector('label[data-test="item-TABLE-table_00000"]')).not.toBeNull();
    expect(container.querySelectorAll('label[data-test^="item-TABLE-"]').length).toBeLessThan(100);
  });

  it("toggles all items of a group through the group header checkbox", async () => {
    const { state, container, app } = mountTree({});
    cleanup = () => app.unmount();
    groupToggle(container).click();
    await nextTick();
    expect(state.selection.VIEW).toEqual(["v1", "v2", "v3"]);
    // clicking again with every visible item selected unchecks them all
    groupToggle(container).click();
    await nextTick();
    expect(state.selection.VIEW ?? []).toEqual([]);
  });

  it("group toggle under a search only touches the visible items", async () => {
    const { state, container, app } = mountTree({ selection: { VIEW: ["v1", "v2", "v3"] } });
    cleanup = () => app.unmount();
    await typeSearch(container, "v2");
    // all visible items (only v2) are selected -> toggle unchecks only v2
    groupToggle(container).click();
    await nextTick();
    expect(state.selection.VIEW).toEqual(["v1", "v3"]);
  });

  it("updates expanded PostgreSQL object lists immediately while searching", async () => {
    const { container, app } = mountTree({ groups: [POSTGRES_FUNCTIONS, POSTGRES_SEQUENCES] });
    cleanup = () => app.unmount();

    expect(container.querySelector('label[data-test="item-FUNCTION-box"]')).not.toBeNull();
    await typeSearch(container, "biz_ban");

    expect(container.querySelector('label[data-test="item-FUNCTION-box"]')).toBeNull();
    expect(container.querySelector('label[data-test="item-SEQUENCE-biz_banner_id_seq"]')).not.toBeNull();
    expect(container.querySelector('[data-test="group-FUNCTION"]')?.textContent).toContain("无匹配");
  });

  it("search ranks exact-prefix matches before mid-name matches", async () => {
    // "abc_users" contains "user" but doesn't start with it; "users_archive"
    // and "user_log" are both true prefix matches and should be sorted
    // ahead of it, keeping their own relative order (stable sort).
    const SEARCHABLE: TreeGroup = { kind: "TABLE", label: "Tables", items: ["abc_users", "users_archive", "xuser_log", "user_log"] };
    const { container, app } = mountTree({ groups: [SEARCHABLE] });
    cleanup = () => app.unmount();
    await typeSearch(container, "user");
    const order = Array.from(container.querySelectorAll('label[data-test^="item-TABLE-"]')).map((el) => el.getAttribute("data-test")!.replace("item-TABLE-", ""));
    expect(order).toEqual(["users_archive", "user_log", "abc_users", "xuser_log"]);
  });

  it("deselect all only clears visible enabled selections, keeping hidden ones", async () => {
    const { state, container, app } = mountTree({
      selection: { VIEW: ["v1", "v2", "v3"], FUNCTION: ["f1", "f2"] },
    });
    cleanup = () => app.unmount();
    await typeSearch(container, "v1");
    toolbarButton(container, "transfer.deselectAll")!.click();
    await nextTick();
    expect(state.selection.VIEW).toEqual(["v2", "v3"]); // hidden selections survive
    expect(state.selection.FUNCTION).toEqual(["f1", "f2"]);
  });

  it("deselect all skips disabled groups entirely", async () => {
    const { state, container, app } = mountTree({
      groups: [TABLES, VIEWS],
      disabledGroups: ["VIEW"],
      selection: { TABLE: ["t1", "t2"], VIEW: ["v1", "v2"] },
    });
    cleanup = () => app.unmount();
    toolbarButton(container, "transfer.deselectAll")!.click();
    await nextTick();
    expect(state.selection.TABLE ?? []).toEqual([]);
    expect(state.selection.VIEW).toEqual(["v1", "v2"]);
  });

  it("select all only selects visible enabled groups, merging hidden selections", async () => {
    const { state, container, app } = mountTree({
      selection: { VIEW: ["v1"], FUNCTION: [] },
    });
    cleanup = () => app.unmount();
    await typeSearch(container, "v2");
    // VIEW is the only group with visible items; FUNCTION items are filtered out
    toolbarButton(container, "transfer.selectAll")!.click();
    await nextTick();
    expect(state.selection.VIEW).toEqual(["v1", "v2"]);
    expect(state.selection.FUNCTION ?? []).toEqual([]);
  });

  it("select all skips disabled groups", async () => {
    const { state, container, app } = mountTree({
      groups: [TABLES, VIEWS],
      disabledGroups: ["VIEW"],
    });
    cleanup = () => app.unmount();
    toolbarButton(container, "transfer.selectAll")!.click();
    await nextTick();
    expect(state.selection.TABLE).toEqual(["t1", "t2"]);
    expect(state.selection.VIEW ?? []).toEqual([]);
  });

  it("shows select-all while some visible enabled items are still unselected", async () => {
    // user scenario: every TABLE selected but VIEW untouched -> select-all
    const { container, app } = mountTree({
      groups: [TABLES, VIEWS],
      selection: { TABLE: ["t1", "t2"], VIEW: ["v1"] },
    });
    cleanup = () => app.unmount();
    expect(toolbarButton(container, "transfer.selectAll")).toBeDefined();
    expect(toolbarButton(container, "transfer.deselectAll")).toBeUndefined();
  });

  it("shows deselect-all only when every visible enabled item is selected", async () => {
    const { state, container, app } = mountTree({
      selection: { VIEW: ["v1", "v2", "v3"], FUNCTION: ["f1", "f2"] },
    });
    cleanup = () => app.unmount();
    expect(toolbarButton(container, "transfer.deselectAll")).toBeDefined();
    expect(toolbarButton(container, "transfer.selectAll")).toBeUndefined();
    // deselecting everything flips the button back to select-all
    toolbarButton(container, "transfer.deselectAll")!.click();
    await nextTick();
    expect(state.selection).toEqual({});
    expect(toolbarButton(container, "transfer.selectAll")).toBeDefined();
  });

  it("search-filtered view: all visible items selected still shows deselect-all", async () => {
    const { container, app } = mountTree({
      selection: { VIEW: ["v1", "v2", "v3"], FUNCTION: ["f1"] },
    });
    cleanup = () => app.unmount();
    // only v1 and f1 remain visible; both are selected -> deselect-all
    await typeSearch(container, "1");
    expect(toolbarButton(container, "transfer.deselectAll")).toBeDefined();
    // filtering to nothing leaves only hidden selections -> select-all is shown again
    await typeSearch(container, "zzz-no-match");
    expect(toolbarButton(container, "transfer.selectAll")).toBeDefined();
    expect(toolbarButton(container, "transfer.deselectAll")).toBeUndefined();
  });

  it("hidden selections in disabled groups do not surface the deselect button", async () => {
    const { container, app } = mountTree({
      groups: [TABLES, VIEWS],
      disabledGroups: ["VIEW"],
      selection: { VIEW: ["v1", "v2"] },
    });
    cleanup = () => app.unmount();
    expect(toolbarButton(container, "transfer.selectAll")).toBeDefined();
    expect(toolbarButton(container, "transfer.deselectAll")).toBeUndefined();
  });

  it("item checkbox toggles a single selection", async () => {
    const { state, container, app } = mountTree({});
    cleanup = () => app.unmount();
    itemCheckbox(container, "VIEW", "v2").click();
    await nextTick();
    expect(state.selection.VIEW).toEqual(["v2"]);
    itemCheckbox(container, "VIEW", "v2").click();
    await nextTick();
    expect(state.selection.VIEW ?? []).toEqual([]);
  });

  it("group header checkbox shows none / partial / all tri-state", async () => {
    // none: no selection in the group
    const none = mountTree({ groups: [VIEWS], selection: {} });
    cleanup = () => none.app.unmount();
    expect(groupToggle(none.container).dataset.state).toBe("none");
    none.app.unmount();

    // partial: only some visible items selected
    const partial = mountTree({ groups: [VIEWS], selection: { VIEW: ["v1"] } });
    cleanup = () => partial.app.unmount();
    expect(groupToggle(partial.container).dataset.state).toBe("partial");
    partial.app.unmount();

    // all: every visible item selected
    const all = mountTree({ groups: [VIEWS], selection: { VIEW: ["v1", "v2", "v3"] } });
    cleanup = () => all.app.unmount();
    expect(groupToggle(all.container).dataset.state).toBe("all");
    all.app.unmount();
  });

  it("group header state is computed over visible items only", async () => {
    // every item selected, but the search narrows the visible set to v1
    const { container, app } = mountTree({ groups: [VIEWS], selection: { VIEW: ["v1", "v2", "v3"] } });
    cleanup = () => app.unmount();
    await typeSearch(container, "v1");
    // v1 is the only visible item and it is selected -> all
    expect(groupToggle(container).dataset.state).toBe("all");
    // clearing the search shows every item selected again -> all
    await typeSearch(container, "");
    expect(groupToggle(container).dataset.state).toBe("all");
  });
});
