import { beforeEach, describe, expect, it, vi } from "vitest";
import { orderDataGridFilterModeOptions, resetDataGridFilterModeOrder, saveDataGridFilterModeOrder } from "@/lib/dataGrid/dataGridFilterModeOrder";

const options = [
  { value: "equals", labelKey: "grid.filterBuilderEquals" },
  { value: "like", labelKey: "grid.filterBuilderContains" },
  { value: "is-null", labelKey: "grid.filterBuilderIsNull" },
] as const;

describe("data grid filter mode order", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.restoreAllMocks();
  });

  it("stores independent orders for each database type", () => {
    saveDataGridFilterModeOrder("mysql", ["like", "equals", "is-null"]);
    saveDataGridFilterModeOrder("postgres", ["is-null", "equals", "like"]);

    expect(orderDataGridFilterModeOptions("mysql", options).map((item) => item.value)).toEqual(["like", "equals", "is-null"]);
    expect(orderDataGridFilterModeOptions("postgres", options).map((item) => item.value)).toEqual(["is-null", "equals", "like"]);
  });

  it("keeps newly added operators at the end and restores the default order", () => {
    saveDataGridFilterModeOrder("mysql", ["like"]);
    expect(orderDataGridFilterModeOptions("mysql", options).map((item) => item.value)).toEqual(["like", "equals", "is-null"]);

    resetDataGridFilterModeOrder("mysql");
    expect(orderDataGridFilterModeOptions("mysql", options).map((item) => item.value)).toEqual(["equals", "like", "is-null"]);
  });

  it("ignores malformed persisted data", () => {
    storage.set("dbx-data-grid-filter-mode-order-v1", "not-json");
    expect(orderDataGridFilterModeOptions("mysql", options).map((item) => item.value)).toEqual(["equals", "like", "is-null"]);
  });
});
