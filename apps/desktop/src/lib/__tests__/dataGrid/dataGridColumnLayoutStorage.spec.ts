import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentDataGridColumnLayoutScopeKey,
  loadDataGridColumnLayout,
  loadDataGridColumnOrder,
  loadTableDataGridColumnOrder,
  loadTableDataGridColumnOrderEntry,
  notifyTableDataGridColumnOrderChanged,
  removeDataGridColumnOrder,
  removeTableDataGridColumnOrder,
  saveDataGridColumnLayout,
  saveTableDataGridColumnOrder,
  TABLE_DATA_GRID_COLUMN_ORDER_CHANGED_EVENT,
  tableDataGridColumnOrderScopeKey,
} from "@/lib/dataGrid/dataGridColumnLayoutStorage";

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

  it("drops an order saved against a database column order the table no longer has", () => {
    const scopeKey = tableDataGridColumnOrderScopeKey({ connectionId: "oracle-1", database: "APP", schema: "APP", tableName: "REPORT" });
    saveTableDataGridColumnOrder(scopeKey, ["ID\u00000", "LIAGRO\u00000", "NETINC\u00000", "CF_INFO\u00000"], ["ID\u00000", "NETINC\u00000", "CF_INFO\u00000", "LIAGRO\u00000"]);

    // The table was dropped and recreated with CF_INFO ahead of NETINC.
    expect(loadTableDataGridColumnOrder(scopeKey, ["ID\u00000", "CF_INFO\u00000", "NETINC\u00000", "LIAGRO\u00000"])).toEqual([]);
    expect(loadTableDataGridColumnOrder(scopeKey)).toEqual([]);
    // An empty entry stays behind so views that keep their own copy of the order can tell it was discarded.
    expect(loadTableDataGridColumnOrderEntry(scopeKey)).toEqual([]);
    expect(loadTableDataGridColumnOrderEntry(tableDataGridColumnOrderScopeKey({ connectionId: "oracle-1", database: "APP", schema: "APP", tableName: "OTHER" }))).toBeNull();
  });

  it("keeps an order while the database only adds or drops columns", () => {
    const scopeKey = tableDataGridColumnOrderScopeKey({ connectionId: "oracle-1", database: "APP", schema: "APP", tableName: "REPORT" });
    const order = ["ID\u00000", "LIAGRO\u00000", "NETINC\u00000", "CF_INFO\u00000"];
    saveTableDataGridColumnOrder(scopeKey, order, ["ID\u00000", "NETINC\u00000", "CF_INFO\u00000", "LIAGRO\u00000"]);

    expect(loadTableDataGridColumnOrder(scopeKey, ["ID\u00000", "CF_INFO\u00000", "LIAGRO\u00000", "NOTE\u00000"])).toEqual(order);
    expect(loadTableDataGridColumnOrder(scopeKey, ["ID\u00000", "NETINC\u00000", "CF_INFO\u00000", "LIAGRO\u00000", "NOTE\u00000"])).toEqual(order);
  });

  it("applies an order saved without a database column order", () => {
    const scopeKey = tableDataGridColumnOrderScopeKey({ connectionId: "oracle-1", database: "APP", schema: "APP", tableName: "REPORT" });
    const order = ["LIAGRO\u00000", "ID\u00000"];
    saveTableDataGridColumnOrder(scopeKey, order);

    expect(loadTableDataGridColumnOrder(scopeKey, ["ID\u00000", "LIAGRO\u00000"])).toEqual(order);
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

describe("data grid column layout storage", () => {
  beforeEach(installLocalStorage);
  afterEach(() => vi.unstubAllGlobals());

  it("uses a stable document scope without query or result column signatures", () => {
    expect(
      documentDataGridColumnLayoutScopeKey({
        databaseType: "elasticsearch",
        connectionId: "connection-1",
        database: "database-name",
        collection: "order_index_v1",
      }),
    ).toBe(["document", "elasticsearch", "connection-1", "database-name", "order_index_v1"].join("\u0001"));
  });

  it("stores order and hidden keys without dropping fields absent from the current page", () => {
    const layout = {
      orderKeys: ["_id", "status", "orderNo", "goodsList"],
      hiddenKeys: ["goodsList"],
    };

    saveDataGridColumnLayout("document-layout", layout);

    expect(loadDataGridColumnLayout("document-layout", ["_id", "orderNo", "status", "createTime"])).toEqual(layout);
  });

  it("keeps hidden keys when only the saved order is reset", () => {
    saveDataGridColumnLayout("combined-layout", { orderKeys: ["status", "_id"], hiddenKeys: ["goodsList"] });

    removeDataGridColumnOrder("combined-layout");

    expect(loadDataGridColumnOrder("combined-layout", [])).toEqual([]);
    expect(loadDataGridColumnLayout("combined-layout")).toEqual({ orderKeys: [], hiddenKeys: ["goodsList"] });
  });

  it("loads the previous order-only payload format", () => {
    localStorage.setItem(
      "dbx-data-grid-column-layout:legacy-layout",
      JSON.stringify({
        version: 1,
        columnSignature: "id\0name",
        order: ["name", "id"],
      }),
    );

    expect(loadDataGridColumnLayout("legacy-layout", ["id", "name"])).toEqual({
      orderKeys: ["name", "id"],
      hiddenKeys: [],
    });
  });
});
