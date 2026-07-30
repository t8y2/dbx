import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDataGridColumnLayout } from "@/lib/dataGrid/dataGridColumnLayoutStorage";
import { documentGridColumnVisibilityScopeKey, loadDocumentGridHiddenColumnKeys, migrateDocumentGridColumnVisibilityToLayout, saveDocumentGridHiddenColumnKeys } from "@/lib/document/documentGridColumnVisibilityStorage";

const STORAGE_PREFIX = "dbx-document-grid-column-visibility:v1:";
let storedValues: Map<string, string>;

function installLocalStorage() {
  storedValues = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
    removeItem: (key: string) => storedValues.delete(key),
  });
}

function scopeKey(collection: string) {
  return documentGridColumnVisibilityScopeKey({
    databaseType: "elasticsearch",
    connectionId: "connection-1",
    database: "",
    collection,
  });
}

describe("document grid column visibility storage", () => {
  beforeEach(installLocalStorage);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stores normalized hidden field names", () => {
    const ordersScope = scopeKey("orders");

    saveDocumentGridHiddenColumnKeys(ordersScope, ["goodsList", "logisticsInfo", "goodsList"]);

    expect(loadDocumentGridHiddenColumnKeys(ordersScope)).toEqual(["goodsList", "logisticsInfo"]);
  });

  it("isolates indexes and removes the persisted selection when all fields are shown", () => {
    const ordersScope = scopeKey("orders");
    const productsScope = scopeKey("products");
    saveDocumentGridHiddenColumnKeys(ordersScope, ["goodsList"]);

    expect(loadDocumentGridHiddenColumnKeys(productsScope)).toEqual([]);

    saveDocumentGridHiddenColumnKeys(ordersScope, []);

    expect(storedValues.has(`${STORAGE_PREFIX}${ordersScope}`)).toBe(false);
    expect(loadDocumentGridHiddenColumnKeys(ordersScope)).toEqual([]);
  });

  it("ignores invalid persisted values without hiding unrelated fields", () => {
    const ordersScope = scopeKey("orders");
    storedValues.set(`${STORAGE_PREFIX}${ordersScope}`, JSON.stringify(["goodsList", 42, "goodsList", null]));

    expect(loadDocumentGridHiddenColumnKeys(ordersScope)).toEqual(["goodsList"]);
  });

  it("reports malformed persisted JSON and falls back to all fields visible", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ordersScope = scopeKey("orders");
    storedValues.set(`${STORAGE_PREFIX}${ordersScope}`, "{");

    expect(loadDocumentGridHiddenColumnKeys(ordersScope)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[DBX][document-grid-column-visibility:parse]"), expect.any(SyntaxError));
  });

  it("migrates legacy hidden fields into the unified layout once", () => {
    const ordersScope = scopeKey("orders");
    saveDocumentGridHiddenColumnKeys(ordersScope, ["goodsList"]);

    migrateDocumentGridColumnVisibilityToLayout(ordersScope, "document-layout");
    migrateDocumentGridColumnVisibilityToLayout(ordersScope, "document-layout");

    expect(loadDataGridColumnLayout("document-layout")).toEqual({
      orderKeys: [],
      hiddenKeys: ["goodsList"],
    });
    expect(storedValues.has(`${STORAGE_PREFIX}${ordersScope}`)).toBe(false);
  });
});
