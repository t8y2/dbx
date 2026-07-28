import { strict as assert } from "node:assert";
import { test } from "vitest";
import { columnHeaderCanvasPointerDisabled, columnHeaderClickShouldBeSuppressed, columnHeaderPreviewEnabled, columnHeaderPreviewOffsetForColumn, columnHeaderTooltipDisabled } from "../../apps/desktop/src/lib/dataGrid/dataGridColumnHeaderInteraction";

test("keeps column header tooltips closed during column pointer interactions", () => {
  assert.equal(columnHeaderTooltipDisabled({ columnDragActive: false, columnResizeActive: false }), false);
  assert.equal(columnHeaderTooltipDisabled({ columnDragActive: true, columnResizeActive: false }), true);
  assert.equal(columnHeaderTooltipDisabled({ columnDragActive: false, columnResizeActive: true }), true);
  assert.equal(columnHeaderTooltipDisabled({ columnDragActive: true, columnResizeActive: true }), true);
});

test("enables live column header reorder preview while dragging", () => {
  assert.equal(columnHeaderPreviewEnabled({ columnDragActive: false }), false);
  assert.equal(columnHeaderPreviewEnabled({ columnDragActive: true }), true);
});

test("ignores canvas pointer hit testing during column header interactions", () => {
  assert.equal(columnHeaderCanvasPointerDisabled({ columnDragActive: false, columnResizeActive: false }), false);
  assert.equal(columnHeaderCanvasPointerDisabled({ columnDragActive: true, columnResizeActive: false }), true);
  assert.equal(columnHeaderCanvasPointerDisabled({ columnDragActive: false, columnResizeActive: true }), true);
});

test("suppresses the synthetic click that follows a column header drag", () => {
  assert.equal(columnHeaderClickShouldBeSuppressed({ now: 1000, guardUntil: 0, suppressNextClick: false }), false);
  assert.equal(columnHeaderClickShouldBeSuppressed({ now: 1000, guardUntil: 900, suppressNextClick: false }), false);
  assert.equal(columnHeaderClickShouldBeSuppressed({ now: 1000, guardUntil: 1200, suppressNextClick: false }), true);
  assert.equal(columnHeaderClickShouldBeSuppressed({ now: 1000, guardUntil: 0, suppressNextClick: true }), true);
});

test("calculates live reorder preview offsets for dragged and displaced columns", () => {
  const base = {
    columnDragActive: true,
    sourceVisibleIndex: 1,
    targetVisibleIndex: 3,
    startX: 100,
    currentX: 175,
    sourceWidth: 240,
  };

  assert.equal(columnHeaderPreviewOffsetForColumn({ ...base, visibleColIdx: 1 }), 75);
  assert.equal(columnHeaderPreviewOffsetForColumn({ ...base, visibleColIdx: 2 }), -240);
  assert.equal(columnHeaderPreviewOffsetForColumn({ ...base, visibleColIdx: 3 }), -240);
  assert.equal(columnHeaderPreviewOffsetForColumn({ ...base, visibleColIdx: 4 }), 0);
});
