// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDataGridColumnWidthStates,
  createDataGridColumnMeasurementSignature,
  createDataGridColumnStructureSignature,
  DATA_GRID_COLUMN_WIDTH_STATE_LIMIT,
  loadDataGridColumnWidthState,
  reconcileDataGridColumnWidthStorageIndex,
  removeDataGridColumnWidthState,
  saveDataGridColumnWidthState,
} from "@/lib/dataGrid/dataGridColumnWidthState";

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

  it("invalidates auto-calculated widths but retains user-sized widths across measurement changes", () => {
    const identity = { cacheKey: "result-font-change", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(identity, [0, 1], [100, 200], new Set([1]));

    const differentMeasurement = createDataGridColumnMeasurementSignature("standard", true, [16, "Roboto"]);
    const loaded = loadDataGridColumnWidthState({ cacheKey: "result-font-change", structureSignature, measurementSignature: differentMeasurement }, [0, 1]);
    expect(loaded).toEqual({
      widths: [undefined, 200],
      userSizedColumnIndexes: new Set([1]),
      autoFittedColumnIndexes: new Set(),
    });
  });

  it("completely invalidates cached widths when measurement changes and no columns are user-sized", () => {
    const identity = { cacheKey: "result-font-change-auto-only", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(identity, [0, 1], [100, 200], new Set());

    const differentMeasurement = createDataGridColumnMeasurementSignature("standard", true, [16, "Roboto"]);
    const loaded = loadDataGridColumnWidthState({ cacheKey: "result-font-change-auto-only", structureSignature, measurementSignature: differentMeasurement }, [0, 1]);
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

  it("prunes orphan index entries on read when data is missing from localStorage", () => {
    const validIdentity = { cacheKey: "valid-key", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(validIdentity, [0], [150], new Set([0]));

    // Manually inject an orphan key into the index (simulating a stale entry from a closed/evicted window)
    const index = JSON.parse(localStorage.getItem("dbx-data-grid-column-widths-index") || "[]") as string[];
    index.unshift("orphan-key");
    localStorage.setItem("dbx-data-grid-column-widths-index", JSON.stringify(index));

    // Trying to load the orphan key should return undefined and prune it from the index
    const loaded = loadDataGridColumnWidthState({ cacheKey: "orphan-key", structureSignature, measurementSignature }, [0]);
    expect(loaded).toBeUndefined();

    const updatedIndex = JSON.parse(localStorage.getItem("dbx-data-grid-column-widths-index") || "[]") as string[];
    expect(updatedIndex).not.toContain("orphan-key");
    expect(updatedIndex).toContain("valid-key");
  });

  it("prunes orphan index entries pointing to missing data during write reconciliation", () => {
    const validIdentity = { cacheKey: "valid-key", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(validIdentity, [0], [150], new Set([0]));

    // Manually inject an orphan key into the index
    const index = JSON.parse(localStorage.getItem("dbx-data-grid-column-widths-index") || "[]") as string[];
    index.push("stale-ghost-key");
    localStorage.setItem("dbx-data-grid-column-widths-index", JSON.stringify(index));

    // Writing a new state triggers reconciliation
    const nextIdentity = { cacheKey: "new-key", structureSignature, measurementSignature };
    saveDataGridColumnWidthState(nextIdentity, [0], [200], new Set([0]));

    const updatedIndex = JSON.parse(localStorage.getItem("dbx-data-grid-column-widths-index") || "[]") as string[];
    expect(updatedIndex).not.toContain("stale-ghost-key");
    expect(updatedIndex).toEqual(["valid-key", "new-key"]);
  });

  it("adopts orphan data entries from concurrent multi-window writes and includes them in LRU eviction", () => {
    // Simulate another window writing a data item directly without updating the index (or index write lost to race)
    const orphanDataPayload = JSON.stringify({
      version: 1,
      structureSignature,
      measurementSignature,
      widths: [[0, 180]],
      userSizedColumnIndexes: [0],
    });
    localStorage.setItem("dbx-data-grid-column-widths:concurrent-orphan", orphanDataPayload);
    // Index currently does NOT contain "concurrent-orphan"
    expect(JSON.parse(localStorage.getItem("dbx-data-grid-column-widths-index") || "[]")).not.toContain("concurrent-orphan");

    // Reconcile or trigger save from current window
    const reconciled = reconcileDataGridColumnWidthStorageIndex();
    expect(reconciled).toContain("concurrent-orphan");

    // Write enough items to exceed the limit
    for (let i = 0; i < DATA_GRID_COLUMN_WIDTH_STATE_LIMIT; i++) {
      saveDataGridColumnWidthState({ cacheKey: `fill-${i}`, structureSignature, measurementSignature }, [0], [100 + i], new Set([0]));
    }

    // Since concurrent-orphan was adopted at the oldest end, it should be evicted when capacity is reached
    expect(localStorage.getItem("dbx-data-grid-column-widths:concurrent-orphan")).toBeNull();
  });

  it("cleans up all orphan data entries on clearDataGridColumnWidthStates even if omitted from index", () => {
    // Store valid item
    saveDataGridColumnWidthState({ cacheKey: "indexed-item", structureSignature, measurementSignature }, [0], [120], new Set([0]));

    // Directly insert an unindexed orphan item
    localStorage.setItem("dbx-data-grid-column-widths:unindexed-orphan", JSON.stringify({ version: 1, structureSignature, measurementSignature, widths: [[0, 100]], userSizedColumnIndexes: [0] }));

    clearDataGridColumnWidthStates();

    // Both indexed item and orphan data item must be cleared
    expect(localStorage.getItem("dbx-data-grid-column-widths:indexed-item")).toBeNull();
    expect(localStorage.getItem("dbx-data-grid-column-widths:unindexed-orphan")).toBeNull();
    expect(localStorage.getItem("dbx-data-grid-column-widths-index")).toBeNull();
  });

  it("deduplicates corrupted or raced index entries", () => {
    saveDataGridColumnWidthState({ cacheKey: "dup-1", structureSignature, measurementSignature }, [0], [100], new Set([0]));
    saveDataGridColumnWidthState({ cacheKey: "dup-2", structureSignature, measurementSignature }, [0], [200], new Set([0]));

    // Artificially inject duplicate keys into index
    localStorage.setItem("dbx-data-grid-column-widths-index", JSON.stringify(["dup-1", "dup-1", "dup-2", "dup-2"]));

    const reconciled = reconcileDataGridColumnWidthStorageIndex();
    expect(reconciled).toEqual(["dup-1", "dup-2"]);
  });

  it("preserves keys across simulated concurrent writes from multiple windows", () => {
    // Window A writes item A
    saveDataGridColumnWidthState({ cacheKey: "winA-1", structureSignature, measurementSignature }, [0], [100], new Set([0]));

    // Window B concurrently writes item B directly into localStorage, with an index that didn't know about winA-1
    localStorage.setItem("dbx-data-grid-column-widths:winB-1", JSON.stringify({ version: 1, structureSignature, measurementSignature, widths: [[0, 150]], userSizedColumnIndexes: [0] }));
    // Window B overwrites index to only contain winB-1
    localStorage.setItem("dbx-data-grid-column-widths-index", JSON.stringify(["winB-1"]));

    // Window A now writes item A2
    saveDataGridColumnWidthState({ cacheKey: "winA-2", structureSignature, measurementSignature }, [0], [200], new Set([0]));

    // All three items must be in the index: winA-1 (adopted), winB-1, winA-2
    const finalIndex = JSON.parse(localStorage.getItem("dbx-data-grid-column-widths-index") || "[]") as string[];
    expect(finalIndex).toContain("winA-1");
    expect(finalIndex).toContain("winB-1");
    expect(finalIndex).toContain("winA-2");
    expect(localStorage.getItem("dbx-data-grid-column-widths:winA-1")).toBeTruthy();
    expect(localStorage.getItem("dbx-data-grid-column-widths:winB-1")).toBeTruthy();
    expect(localStorage.getItem("dbx-data-grid-column-widths:winA-2")).toBeTruthy();
  });
});
