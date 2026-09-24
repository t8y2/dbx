// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { dispatch, findAll, findOne, mountComponent } from "./vueHostHarness";
import type { DataGridLocalFilterOption, DataGridLocalFilterSort } from "@/lib/dataGrid/dataGridLocalColumnFilterState";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@lucide/vue", async () => {
  const { createPassthroughStub } = await import("./vueHostHarness");
  const icon = createPassthroughStub("Icon", "i");
  return { ArrowDown: icon, ArrowUp: icon, ArrowUpDown: icon, Check: icon, Database: icon, Filter: icon, Loader2: icon, Search: icon };
});
vi.mock("@/components/ui/button", async () => ({ Button: (await import("./vueHostHarness")).createPassthroughStub("Button", "button") }));
vi.mock("@/components/ui/popover", async () => {
  const { createPassthroughStub } = await import("./vueHostHarness");
  return { Popover: createPassthroughStub("Popover"), PopoverAnchor: createPassthroughStub("PopoverAnchor"), PopoverContent: createPassthroughStub("PopoverContent"), PopoverTrigger: createPassthroughStub("PopoverTrigger") };
});

import DataGridColumnFilterPopover from "@/components/grid/DataGridColumnFilterPopover.vue";

const options: DataGridLocalFilterOption[] = [
  { key: "str:alpha", label: "alpha", count: 1, value: "alpha" },
  { key: "str:beta", label: "beta", count: 3, value: "beta" },
];

function mountPopover(sort: DataGridLocalFilterSort, onSort: ReturnType<typeof vi.fn>) {
  return mountComponent(DataGridColumnFilterPopover, {
    open: true,
    compactHeaderActions: false,
    canUseServerFilter: false,
    active: false,
    serverModeActive: false,
    panelTitle: "status",
    search: "",
    popoverWidth: 280,
    popoverOffsetX: 0,
    draftMode: "local",
    draftValues: new Set(options.map((option) => option.key)),
    options,
    sort,
    allOptionsCount: options.length,
    canApplyTypedValue: false,
    typedValue: "",
    serverLoading: false,
    serverError: "",
    serverLimited: false,
    serverValueLimit: 1000,
    onSort,
  });
}

describe("DataGridColumnFilterPopover sort toggles", () => {
  it("emits sort with the clicked field and announces count-desc / value-asc as the first-click directions", async () => {
    const onSort = vi.fn();
    const mounted = mountPopover({ field: "value", direction: "asc" }, onSort);

    // From the default value-asc state, the count header advertises descending
    // for its first click while the active value header stays ascending.
    const countButton = findOne(mounted.root, (node) => node.props["aria-label"] === "grid.count: grid.sortDescending");
    expect(findOne(mounted.root, (node) => node.props["aria-label"] === "grid.value: grid.sortAscending")).toBeTruthy();

    dispatch(countButton, "click");
    expect(onSort).toHaveBeenCalledExactlyOnceWith("count");

    await mounted.setProps({ sort: { field: "count", direction: "desc" } });
    // Switching back from count-desc, the value header advertises ascending.
    const valueButton = findOne(mounted.root, (node) => node.props["aria-label"] === "grid.value: grid.sortAscending");
    dispatch(valueButton, "click");
    expect(onSort).toHaveBeenLastCalledWith("value");

    expect(onSort).toHaveBeenCalledTimes(2);
    mounted.unmount();
  });

  it("renders plain labels without sort controls outside the local draft mode", async () => {
    const onSort = vi.fn();
    const mounted = mountPopover({ field: "value", direction: "asc" }, onSort);

    await mounted.setProps({ draftMode: "server" });

    expect(findAll(mounted.root, (node) => node.type === "button" && typeof node.props["aria-label"] === "string" && node.props["aria-label"].startsWith("grid.value: "))).toHaveLength(0);
    expect(findAll(mounted.root, (node) => node.type === "button" && typeof node.props["aria-label"] === "string" && node.props["aria-label"].startsWith("grid.count: "))).toHaveLength(0);
    expect(onSort).not.toHaveBeenCalled();
    mounted.unmount();
  });
});
