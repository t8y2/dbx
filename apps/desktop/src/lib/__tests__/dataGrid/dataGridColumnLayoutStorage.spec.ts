import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTableDataGridColumnOrder, notifyTableDataGridColumnOrderChanged, removeTableDataGridColumnOrder, saveTableDataGridColumnOrder, TABLE_DATA_GRID_COLUMN_ORDER_CHANGED_EVENT, tableDataGridColumnOrderScopeKey } from "@/lib/dataGrid/dataGridColumnLayoutStorage";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
}

describe("table data grid column order storage", () => {
  beforeEach(installLocalStorage);
  afterEach(() => vi.unstubAllGlobals());

  it("stores an order independently from the current result column signature", () => {
    const scopeKey = tableDataGridColumnOrderScopeKey({
      connectionId: "sqlserver-1",
      database: "sales",
      schema: "core",
      tableName: "products",
    });
    const order = ["name\u00000", "id\u00000"];

    saveTableDataGridColumnOrder(scopeKey, order);

    expect(loadTableDataGridColumnOrder(scopeKey)).toEqual(order);
  });

  it("isolates tables and removes a saved order", () => {
    const products = tableDataGridColumnOrderScopeKey({ connectionId: "sqlserver-1", database: "sales", schema: "core", tableName: "products" });
    const orders = tableDataGridColumnOrderScopeKey({ connectionId: "sqlserver-1", database: "sales", schema: "core", tableName: "orders" });
    saveTableDataGridColumnOrder(products, ["name\u00000", "id\u00000"]);

    expect(loadTableDataGridColumnOrder(orders)).toEqual([]);
    removeTableDataGridColumnOrder(products);
    expect(loadTableDataGridColumnOrder(products)).toEqual([]);
  });

  it("normalizes a missing schema to the database namespace", () => {
    const withoutSchema = tableDataGridColumnOrderScopeKey({ connectionId: "sqlite-1", database: "main", tableName: "products" });
    const explicitMainSchema = tableDataGridColumnOrderScopeKey({ connectionId: "sqlite-1", database: "main", schema: "main", tableName: "products" });

    expect(withoutSchema).toBe(explicitMainSchema);
  });

  it("notifies other open views when a table order changes", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });

    notifyTableDataGridColumnOrderChanged("table-scope");

    expect(dispatchEvent).toHaveBeenCalledOnce();
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe(TABLE_DATA_GRID_COLUMN_ORDER_CHANGED_EVENT);
    expect(event.detail).toEqual({ scopeKey: "table-scope" });
  });
});
