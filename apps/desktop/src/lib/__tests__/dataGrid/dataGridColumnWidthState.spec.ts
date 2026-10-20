// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDataGridColumnWidthStates, createDataGridColumnMeasurementSignature, createDataGridColumnStructureSignature, DATA_GRID_COLUMN_WIDTH_STATE_LIMIT, loadDataGridColumnWidthState, removeDataGridColumnWidthState, saveDataGridColumnWidthState } from "@/lib/dataGrid/dataGridColumnWidthState";

describe("dataGridColumnWidthState", () => {
  const structureSignature = createDataGridColumnStructureSignature(["id", "name"], ["INT", "VARCHAR"]);
  const measurementSignature = createDataGridColumnMeasurementSignature("standard", true, [12, "Inter"]);

  beforeEach(() => {
    localStorage.clear();
    clearDataGridColumnWidthStates();
  });

  it("stores and retrieves column width state in memory", () => {
    const identity = { cacheKey: "result-1", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(identity, [0, 1], [100, 250], new Set([1]));

    const loaded = loadDataGridColumnWidthState(identity, [0, 1]);
    expect(loaded?.widths).toEqual([100, 250]);
    expect(loaded?.userSizedColumnIndexes).toEqual(new Set([1]));
  });

  it("persists user-sized column widths to localStorage and restores them when in-memory cache is cold", async () => {
    const identity = { cacheKey: "result-file-/queries/test.sql-0", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(identity, [0, 1], [120, 300], new Set([1]));

    // Emulate new session or cold in-memory cache
    const rawSaved = localStorage.getItem("dbx-data-grid-column-widths:result-file-/queries/test.sql-0");
    expect(rawSaved).toBeTruthy();

    // Simulate an app restart: fresh module instance => empty in-memory map, same localStorage.
    vi.resetModules();
    const fresh = await import("@/lib/dataGrid/dataGridColumnWidthState");
    const coldIdentity = { cacheKey: "result-file-/queries/test.sql-0", structureSignature, measurementSignature };
    expect(fresh.dataGridColumnWidthStateCount()).toBe(0);
    const reloaded = fresh.loadDataGridColumnWidthState(coldIdentity, [0, 1]);
    expect(reloaded?.widths).toEqual([120, 300]);
    expect(reloaded?.userSizedColumnIndexes).toEqual(new Set([1]));
  });

  it("does not persist to localStorage if no columns are user-sized", () => {
    const identity = { cacheKey: "auto-fit-only", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(identity, [0, 1], [80, 150], new Set());

    expect(localStorage.getItem("dbx-data-grid-column-widths:auto-fit-only")).toBeNull();
  });

  it("removes from localStorage when removeDataGridColumnWidthState is called", () => {
    const identity = { cacheKey: "to-remove", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(identity, [0, 1], [100, 200], new Set([0, 1]));
    expect(localStorage.getItem("dbx-data-grid-column-widths:to-remove")).toBeTruthy();

    removeDataGridColumnWidthState("to-remove");
    expect(localStorage.getItem("dbx-data-grid-column-widths:to-remove")).toBeNull();
    expect(loadDataGridColumnWidthState(identity, [0, 1])).toBeUndefined();
  });

  it("rejects persisted widths when structure signature does not match", () => {
    const identity = { cacheKey: "result-file-modified", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(identity, [0, 1], [100, 200], new Set([1]));

    const differentStructure = createDataGridColumnStructureSignature(["id", "name", "email"]);
    const loaded = loadDataGridColumnWidthState({ cacheKey: "result-file-modified", structureSignature: differentStructure, measurementSignature }, [0, 1, 2]);
    expect(loaded).toBeUndefined();
  });

  it("rejects persisted widths when measurement signature does not match", () => {
    const identity = { cacheKey: "result-font-change", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(identity, [0, 1], [100, 200], new Set([1]));

    const differentMeasurement = createDataGridColumnMeasurementSignature("standard", true, [16, "Roboto"]);
    const loaded = loadDataGridColumnWidthState({ cacheKey: "result-font-change", structureSignature, measurementSignature: differentMeasurement }, [0, 1]);
    expect(loaded).toBeUndefined();
  });

  it("evicts oldest localStorage entries when exceeding state limit", () => {
    for (let i = 0; i < DATA_GRID_COLUMN_WIDTH_STATE_LIMIT + 5; i++) {
      saveDataGridColumnWidthState({ cacheKey: `item-${i}`, structureSignature, measurementSignature }, [0], [100 + i], new Set([0]));
    }

    // Earliest 5 should be evicted from localStorage
    expect(localStorage.getItem("dbx-data-grid-column-widths:item-0")).toBeNull();
    expect(localStorage.getItem("dbx-data-grid-column-widths:item-4")).toBeNull();
    // Latest should exist
    expect(localStorage.getItem(`dbx-data-grid-column-widths:item-${DATA_GRID_COLUMN_WIDTH_STATE_LIMIT + 4}`)).toBeTruthy();
  });
});
