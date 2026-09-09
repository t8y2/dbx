import { beforeEach, describe, expect, it } from "vitest";
import {
  DATA_GRID_VIEW_SNAPSHOT_RESTORE,
  MAX_CACHE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SPARSE_CELL_ENTRIES,
  beginClosingDataGridViewSnapshotsForTab,
  buildDataGridViewProbe,
  clampDataGridViewSelection,
  clearDataGridViewSnapshot,
  clearDataGridViewSnapshotsForTab,
  dataGridViewSnapshotCacheBytes,
  dataGridViewSnapshotCacheSize,
  peekDataGridViewSnapshot,
  resetDataGridViewSnapshots,
  saveDataGridViewSnapshot,
  shouldNotifyOverBudgetSelection,
  type DataGridViewSelectionSnapshot,
  type DataGridViewSnapshot,
} from "@/lib/dataGrid/dataGridViewStateCache";

function snapshot(ownerKey: string, patch: Partial<DataGridViewSnapshot> = {}): DataGridViewSnapshot {
  return {
    ownerKey,
    viewGeneration: "gen-1",
    probe: "probe",
    renderer: "dom",
    rowCount: 10,
    columnCount: 2,
    viewport: { top: 100, left: 0 },
    ...patch,
  };
}

function sparseCellSelection(count: number): DataGridViewSelectionSnapshot {
  return { kind: "cells", cellKeys: Array.from({ length: count }, (_, index) => `${index}:${index}`) };
}

describe("dataGridViewStateCache", () => {
  beforeEach(() => {
    resetDataGridViewSnapshots();
  });

  it("exposes an enabled rollback switch by default", () => {
    expect(DATA_GRID_VIEW_SNAPSHOT_RESTORE).toBe(true);
  });

  it("round-trips a snapshot and refreshes LRU recency on peek", () => {
    saveDataGridViewSnapshot(snapshot("tab-1-run-1-0"));
    expect(peekDataGridViewSnapshot("tab-1-run-1-0")?.viewport.top).toBe(100);
    expect(peekDataGridViewSnapshot("missing")).toBeUndefined();
  });

  it("caps the cache at 32 owners and evicts the least recently used", () => {
    for (let index = 0; index < 33; index += 1) saveDataGridViewSnapshot(snapshot(`tab-${index}`));

    expect(dataGridViewSnapshotCacheSize()).toBe(32);
    expect(peekDataGridViewSnapshot("tab-0")).toBeUndefined();
    expect(peekDataGridViewSnapshot("tab-32")).toBeDefined();
  });

  it("measures size in bytes, not UTF-16 code units", () => {
    // A selection of multi-byte characters: byte length exceeds code-unit count.
    const selection: DataGridViewSelectionSnapshot = { kind: "cells", cellKeys: Array.from({ length: 300 }, () => "格:式") };
    const stored = snapshot("tab-1", { selection });

    saveDataGridViewSnapshot(stored);

    // ~300 CJK keys cost well above 600 UTF-16 units but above 1800 bytes; a
    // code-unit measure would keep this under a tiny budget while bytes exceed it.
    const kept = peekDataGridViewSnapshot("tab-1");
    expect(JSON.stringify(kept ?? {}).length).toBeGreaterThan(600);
  });

  it("drops the cell keys when they exceed the per-snapshot byte budget and marks the snapshot", () => {
    // Long keys push the serialized selection past the 64 KB budget.
    const selection: DataGridViewSelectionSnapshot = { kind: "cells", cellKeys: Array.from({ length: 1200 }, (_, index) => `${index}:${"cell".repeat(20)}`) };
    const result = saveDataGridViewSnapshot(snapshot("tab-1", { selection }));

    expect(result.droppedSelection).toBe(true);
    const kept = peekDataGridViewSnapshot("tab-1");
    expect(kept?.selection?.kind === "cells" && kept.selection.cellKeys).toEqual([]);
    expect(kept?.selectionDropped).toBe(true);
    expect(kept?.viewport.top).toBe(100);
    expect(dataGridViewSnapshotCacheBytes()).toBeLessThan(MAX_SNAPSHOT_BYTES);
  });

  it("keeps a selection that fits the budget without a dropped flag", () => {
    const result = saveDataGridViewSnapshot(snapshot("tab-1", { selection: sparseCellSelection(3) }));

    expect(result.droppedSelection).toBe(false);
    const kept = peekDataGridViewSnapshot("tab-1");
    expect(kept?.selection?.kind === "cells" && kept.selection.cellKeys).toHaveLength(3);
    expect(kept?.selectionDropped).toBeUndefined();
  });

  it("clamps cell keys beyond the sparse cardinality cap", () => {
    const over = sparseCellSelection(MAX_SPARSE_CELL_ENTRIES + 1);
    const result = clampDataGridViewSelection(over);

    expect(result.droppedSelection).toBe(true);
    expect(result.selection.kind === "cells" && result.selection.cellKeys).toEqual([]);
    expect(clampDataGridViewSelection(sparseCellSelection(MAX_SPARSE_CELL_ENTRIES)).droppedSelection).toBe(false);
  });

  it("clears a single owner and its notice marker", () => {
    saveDataGridViewSnapshot(snapshot("tab-1"));
    expect(shouldNotifyOverBudgetSelection("tab-1", "gen-1")).toBe(true);

    clearDataGridViewSnapshot("tab-1");

    expect(peekDataGridViewSnapshot("tab-1")).toBeUndefined();
    expect(shouldNotifyOverBudgetSelection("tab-1", "gen-1")).toBe(true);
  });

  it("clears every snapshot belonging to a tab", () => {
    saveDataGridViewSnapshot(snapshot("tab-1-run-a-0"));
    saveDataGridViewSnapshot(snapshot("tab-1-run-b-0"));
    saveDataGridViewSnapshot(snapshot("tab-2-run-a-0"));

    clearDataGridViewSnapshotsForTab("tab-1");

    expect(peekDataGridViewSnapshot("tab-1-run-a-0")).toBeUndefined();
    expect(peekDataGridViewSnapshot("tab-1-run-b-0")).toBeUndefined();
    expect(peekDataGridViewSnapshot("tab-2-run-a-0")).toBeDefined();
  });

  it("lets a tab capture again right after a plain clear (no tombstone)", () => {
    clearDataGridViewSnapshotsForTab("tab-1");
    saveDataGridViewSnapshot(snapshot("tab-1"));

    expect(peekDataGridViewSnapshot("tab-1")).toBeDefined();
  });

  it("notifies at most once per owner and generation", () => {
    expect(shouldNotifyOverBudgetSelection("tab-1", "gen-1")).toBe(true);
    expect(shouldNotifyOverBudgetSelection("tab-1", "gen-1")).toBe(false);
    // A new logical result is a new chance to report.
    expect(shouldNotifyOverBudgetSelection("tab-1", "gen-2")).toBe(true);
    expect(shouldNotifyOverBudgetSelection("tab-2", "gen-1")).toBe(true);
  });

  it("keeps the whole cache within the global byte budget", () => {
    for (let index = 0; index < 40; index += 1) {
      saveDataGridViewSnapshot(snapshot(`tab-${index}`, { selection: sparseCellSelection(2000) }));
    }

    expect(dataGridViewSnapshotCacheBytes()).toBeLessThanOrEqual(MAX_CACHE_BYTES);
    expect(dataGridViewSnapshotCacheSize()).toBeLessThanOrEqual(32);
  });

  it("blocks writes for a closing tab without requiring window timers", () => {
    const originalWindow = globalThis.window;
    // Test hosts may stub `window` without timer functions.
    (globalThis as { window?: unknown }).window = {};
    try {
      expect(() => beginClosingDataGridViewSnapshotsForTab("tab-1")).not.toThrow();
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }

    saveDataGridViewSnapshot(snapshot("tab-1"));

    expect(peekDataGridViewSnapshot("tab-1")).toBeUndefined();
  });
});

describe("buildDataGridViewProbe", () => {
  it("is deterministic and bounded", () => {
    const long = "x".repeat(500);
    const input = {
      columns: Array.from({ length: 40 }, (_, index) => `column-${index}`),
      columnTypes: Array.from({ length: 40 }, (_, index) => `type-${index}`),
      rowCount: 3,
      firstRow: [long, 1, 2, 3, 4],
      lastRow: ["z", 1],
    };

    const probe = buildDataGridViewProbe(input);

    expect(probe).toBe(buildDataGridViewProbe(input));
    expect(probe).not.toContain(long);
    expect(probe).toContain("x".repeat(64));
    // Bounded to 16 columns / 4 probed row columns.
    expect(probe).not.toContain("column-20");
  });

  it("changes when the dataset changes", () => {
    const base = { columns: ["id", "name"], rowCount: 1, firstRow: [1, "a"] };

    expect(buildDataGridViewProbe(base)).not.toBe(buildDataGridViewProbe({ ...base, firstRow: [2, "a"] }));
    expect(buildDataGridViewProbe(base)).not.toBe(buildDataGridViewProbe({ ...base, rowCount: 2 }));
    expect(buildDataGridViewProbe(base)).not.toBe(buildDataGridViewProbe({ ...base, columns: ["id", "other"] }));
  });

  it("skips large-value cells instead of reading them", () => {
    const input = {
      columns: ["id", "blob"],
      rowCount: 1,
      firstRow: [1, "huge-value"],
      largeValueCells: [{ row_index: 0, column_index: 1 }],
    };

    expect(buildDataGridViewProbe(input)).not.toContain("huge-value");
  });
});
