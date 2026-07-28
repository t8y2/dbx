import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDataGridColumnFrozenCount, loadDataGridColumnFrozenState, removeDataGridColumnFrozenCount, saveDataGridColumnFrozenCount } from "@/lib/dataGrid/dataGridColumnLayoutStorage";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
}

describe("data grid column frozen count storage", () => {
  beforeEach(installLocalStorage);
  afterEach(() => vi.unstubAllGlobals());

  it("returns 0 when no frozen count is stored", () => {
    expect(loadDataGridColumnFrozenCount("scope-1")).toBe(0);
  });

  it("saves and loads a frozen column count", () => {
    saveDataGridColumnFrozenCount("scope-1", 3);
    expect(loadDataGridColumnFrozenCount("scope-1")).toBe(3);
  });

  it("isolates frozen counts between different scope keys", () => {
    saveDataGridColumnFrozenCount("scope-1", 2);
    saveDataGridColumnFrozenCount("scope-2", 5);

    expect(loadDataGridColumnFrozenCount("scope-1")).toBe(2);
    expect(loadDataGridColumnFrozenCount("scope-2")).toBe(5);
  });

  it("removes a stored frozen count", () => {
    saveDataGridColumnFrozenCount("scope-1", 3);
    removeDataGridColumnFrozenCount("scope-1");
    expect(loadDataGridColumnFrozenCount("scope-1")).toBe(0);
  });

  it("does not affect other scope keys when removing", () => {
    saveDataGridColumnFrozenCount("scope-1", 2);
    saveDataGridColumnFrozenCount("scope-2", 4);
    removeDataGridColumnFrozenCount("scope-1");
    expect(loadDataGridColumnFrozenCount("scope-1")).toBe(0);
    expect(loadDataGridColumnFrozenCount("scope-2")).toBe(4);
  });

  it("returns 0 for corrupted stored data", () => {
    localStorage.setItem("dbx-data-grid-frozen-columns:scope-bad", "not-json");
    expect(loadDataGridColumnFrozenCount("scope-bad")).toBe(0);
  });

  it("overwrites an existing frozen count", () => {
    saveDataGridColumnFrozenCount("scope-1", 2);
    saveDataGridColumnFrozenCount("scope-1", 5);
    expect(loadDataGridColumnFrozenCount("scope-1")).toBe(5);
  });

  it("stores frozen count as a structured object with version", () => {
    saveDataGridColumnFrozenCount("scope-1", 3);
    const raw = localStorage.getItem("dbx-data-grid-frozen-columns:scope-1");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual({ version: 1, frozenCount: 3 });
  });

  it("stores and loads the column order from before selected columns were frozen", () => {
    saveDataGridColumnFrozenCount("scope-1", 2, ["id", "name", "email"]);

    expect(loadDataGridColumnFrozenState("scope-1")).toEqual({
      frozenCount: 2,
      orderBeforeFreeze: ["id", "name", "email"],
    });
  });
});
