import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  dataGridFrameContainsCell,
  dataGridFrameCoversRow,
  dataGridSelectionEdgeFlags,
  dataGridSelectionEdgeMask,
  dataGridSelectionFrameKindAtCell,
  dataGridSelectionUsesOuterFrame,
  resolveDataGridSelectionFrames,
} from "../../apps/desktop/src/lib/dataGrid/dataGridSelectionFrames.ts";

test("rectangular range selection resolves to a single frame", () => {
  const result = resolveDataGridSelectionFrames({
    sparseCellCount: 0,
    hasColumnSelection: false,
    selectedColumnIndexes: new Set(),
    selectedRange: { startRow: 2, endRow: 5, startCol: 1, endCol: 3 },
    rowCount: 100,
  });

  assert.equal(result.sparse, false);
  assert.deepEqual(result.frames, [{ startRow: 2, endRow: 5, startCol: 1, endCol: 3 }]);
});

test("select-all resolves to one full-grid frame", () => {
  const result = resolveDataGridSelectionFrames({
    sparseCellCount: 0,
    hasColumnSelection: false,
    selectedColumnIndexes: new Set(),
    selectedRange: { startRow: 0, endRow: 99, startCol: 0, endCol: 7 },
    rowCount: 100,
  });

  assert.equal(result.sparse, false);
  assert.deepEqual(result.frames, [{ startRow: 0, endRow: 99, startCol: 0, endCol: 7 }]);
});

test("sparse ctrl-click cells stay in per-cell border mode", () => {
  const result = resolveDataGridSelectionFrames({
    sparseCellCount: 3,
    hasColumnSelection: false,
    selectedColumnIndexes: new Set(),
    selectedRange: { startRow: 0, endRow: 2, startCol: 0, endCol: 2 },
    rowCount: 100,
  });

  assert.equal(result.sparse, true);
  assert.deepEqual(result.frames, []);
});

test("column selection groups contiguous columns into one frame per run", () => {
  const result = resolveDataGridSelectionFrames({
    sparseCellCount: 0,
    hasColumnSelection: true,
    selectedColumnIndexes: new Set([4, 1, 2, 3, 6]),
    selectedRange: null,
    rowCount: 50,
  });

  assert.equal(result.sparse, false);
  assert.deepEqual(result.frames, [
    { startRow: 0, endRow: 49, startCol: 1, endCol: 4 },
    { startRow: 0, endRow: 49, startCol: 6, endCol: 6 },
  ]);
});

test("no selection resolves to no frames and not sparse", () => {
  const result = resolveDataGridSelectionFrames({
    sparseCellCount: 0,
    hasColumnSelection: false,
    selectedColumnIndexes: new Set(),
    selectedRange: null,
    rowCount: 10,
  });

  assert.equal(result.sparse, false);
  assert.deepEqual(result.frames, []);
});

test("edge flags mark only the outer boundary of a frame", () => {
  const frames = [{ startRow: 2, endRow: 4, startCol: 1, endCol: 3 }];

  // 内部格：四边都不是外框
  assert.deepEqual(dataGridSelectionEdgeFlags(frames, 3, 2), { top: false, right: false, bottom: false, left: false });
  // 左上角
  assert.deepEqual(dataGridSelectionEdgeFlags(frames, 2, 1), { top: true, right: false, bottom: false, left: true });
  // 右下角
  assert.deepEqual(dataGridSelectionEdgeFlags(frames, 4, 3), { top: false, right: true, bottom: true, left: false });
  // 上边缘中间格
  assert.deepEqual(dataGridSelectionEdgeFlags(frames, 2, 2), { top: true, right: false, bottom: false, left: false });
  // 选区外
  assert.equal(dataGridSelectionEdgeFlags(frames, 0, 0), null);
  assert.equal(dataGridSelectionEdgeFlags(frames, 5, 2), null);
});

test("single cell frame is its own boundary on all sides", () => {
  const frames = [{ startRow: 7, endRow: 7, startCol: 2, endCol: 2 }];

  assert.deepEqual(dataGridSelectionEdgeFlags(frames, 7, 2), { top: true, right: true, bottom: true, left: true });
  assert.equal(dataGridFrameContainsCell(frames, 7, 2), true);
  assert.equal(dataGridFrameContainsCell(frames, 7, 3), false);
});

test("frame kind distinguishes single-cell borders from range inversion", () => {
  const single = [{ startRow: 7, endRow: 7, startCol: 2, endCol: 2 }];
  const range = [{ startRow: 0, endRow: 9, startCol: 1, endCol: 3 }];

  assert.equal(dataGridSelectionFrameKindAtCell(single, 7, 2), "single");
  assert.equal(dataGridSelectionFrameKindAtCell(single, 7, 3), null);
  assert.equal(dataGridSelectionFrameKindAtCell(range, 0, 1), "range");
  assert.equal(dataGridSelectionFrameKindAtCell(range, 5, 3), "range");
  assert.equal(dataGridSelectionFrameKindAtCell(range, 5, 4), null);
  assert.equal(dataGridSelectionFrameKindAtCell([], 5, 3), null);
});

test("one-row-wide or one-column-wide frames still count as range", () => {
  assert.equal(dataGridSelectionFrameKindAtCell([{ startRow: 3, endRow: 3, startCol: 0, endCol: 2 }], 3, 1), "range");
  assert.equal(dataGridSelectionFrameKindAtCell([{ startRow: 0, endRow: 5, startCol: 4, endCol: 4 }], 2, 4), "range");
});

test("frame coverage drives row-number highlight", () => {
  const frames = [
    { startRow: 2, endRow: 4, startCol: 1, endCol: 3 },
    { startRow: 7, endRow: 9, startCol: 6, endCol: 6 },
  ];

  assert.equal(dataGridFrameCoversRow(frames, 2), true);
  assert.equal(dataGridFrameCoversRow(frames, 9), true);
  assert.equal(dataGridFrameCoversRow(frames, 5), false);
  assert.equal(dataGridFrameCoversRow([], 2), false);
});

test("outer-frame mode is true only when a multi-cell frame exists", () => {
  assert.equal(dataGridSelectionUsesOuterFrame([{ startRow: 0, endRow: 2, startCol: 1, endCol: 3 }]), true);
  assert.equal(dataGridSelectionUsesOuterFrame([{ startRow: 7, endRow: 7, startCol: 2, endCol: 2 }]), false);
  assert.equal(dataGridSelectionUsesOuterFrame([]), false);
});

test("edge mask encodes outer borders for CSS class selection", () => {
  const frames = [{ startRow: 2, endRow: 4, startCol: 1, endCol: 3 }];

  // interior → 0
  assert.equal(dataGridSelectionEdgeMask(frames, 3, 2), 0);
  // top-left: top|left = 1|8 = 9
  assert.equal(dataGridSelectionEdgeMask(frames, 2, 1), 9);
  // bottom-right: right|bottom = 2|4 = 6
  assert.equal(dataGridSelectionEdgeMask(frames, 4, 3), 6);
  // single-cell frame never paints outer-frame classes
  assert.equal(dataGridSelectionEdgeMask([{ startRow: 7, endRow: 7, startCol: 2, endCol: 2 }], 7, 2), 0);
});
