import { strict as assert } from "node:assert";
import { test } from "vitest";
import { canvasDataGridActionReservedWidth, drawBooleanCheckbox, fitCanvasText, resolveCanvasCellTextLayout, resolveCanvasDataGridRowBase, resolveCanvasDataGridRowFill } from "../../apps/desktop/src/lib/dataGrid/canvasDataGridRenderer.ts";
import { DATA_GRID_DARK_STRIPED_ROW_BG, DATA_GRID_LIGHT_STRIPED_ROW_BG, resolveDataGridPaintTheme } from "../../apps/desktop/src/lib/dataGrid/dataGridPaintTheme.ts";

function rgbChannels(color: string): number[] {
  const match = color.match(/rgba?\(([^)]+)\)/);
  assert.ok(match, `not an rgb colour: ${color}`);
  return match[1]!.split(",").slice(0, 3).map((part) => Number.parseFloat(part.trim()));
}

/** 最大单通道差值：用于证明「一眼可辨」，而不是仅仅不相等。 */
function channelDistance(first: string, second: string): number {
  const left = rgbChannels(first);
  const right = rgbChannels(second);
  return Math.max(...left.map((channel, index) => Math.abs(channel - right[index]!)));
}

function measureContext(charWidth = 1): CanvasRenderingContext2D {
  return {
    font: "13px sans-serif",
    measureText: (text: string) => ({ width: text.length * charWidth }),
  } as CanvasRenderingContext2D;
}

test("fitCanvasText keeps text that fits the available cell width", () => {
  const ctx = measureContext();
  const text = "1234567890abcdefghijklmnopqrst";

  assert.equal(fitCanvasText(ctx, text, text.length), text);
});

test("fitCanvasText truncates only when text exceeds the available cell width", () => {
  const ctx = measureContext();

  assert.equal(fitCanvasText(ctx, "1234567890", 8), "12345...");
});

test("fitCanvasText preserves the numeric suffix for right-aligned narrow cells", () => {
  const ctx = measureContext();

  assert.equal(fitCanvasText(ctx, "1234567890", 8, "right"), "...67890");
});

test("canvas text layout reserves hover actions only for right-aligned cells", () => {
  assert.deepEqual(resolveCanvasCellTextLayout({ drawX: 100, colWidth: 80, dpr: 1, isRightAlign: true, reservedWidth: 28 }), {
    textAnchorX: 140,
    maxWidth: 28,
  });
  assert.deepEqual(resolveCanvasCellTextLayout({ drawX: 100, colWidth: 80, dpr: 1, isRightAlign: false, reservedWidth: 28 }), {
    textAnchorX: 112,
    maxWidth: 56,
  });
  assert.equal(canvasDataGridActionReservedWidth(false), 28);
  assert.equal(canvasDataGridActionReservedWidth(true), 50);
});

test("canvas row fill keeps frozen and scrolling regions on the same selection surface", () => {
  const theme = { cellActive: "active-blue", cellSelected: "selected-blue" };

  assert.equal(resolveCanvasDataGridRowFill(theme, "base", { isActive: true, isDeleted: false, isSelected: false }), "active-blue");
  assert.equal(resolveCanvasDataGridRowFill(theme, "base", { isActive: true, isDeleted: false, isSelected: true }), "selected-blue");
  assert.equal(resolveCanvasDataGridRowFill(theme, "deleted", { isActive: true, isDeleted: true, isSelected: false }), "deleted");
});

test("data grid paint themes use the increased striped row contrast", () => {
  const getVar = () => "";

  const lightTheme = resolveDataGridPaintTheme({ getVar, isDark: false });
  assert.equal(lightTheme.rowMuted, DATA_GRID_LIGHT_STRIPED_ROW_BG);
  assert.notEqual(lightTheme.rowMuted, lightTheme.rowNew);
  assert.equal(resolveDataGridPaintTheme({ getVar, isDark: true }).rowMuted, DATA_GRID_DARK_STRIPED_ROW_BG);
});

test("pending new rows are visually distinct from striped rows and the base surface in both themes", () => {
  const getVar = () => "";

  for (const isDark of [false, true]) {
    const theme = resolveDataGridPaintTheme({ getVar, isDark });
    // 19/20 世纪那种「243 vs 240」的差距在屏幕上不可辨：要求至少一个通道差 ≥ 8
    assert.ok(channelDistance(theme.rowNew, theme.rowMuted) >= 8, `new vs striped (dark=${isDark}): ${theme.rowNew} / ${theme.rowMuted}`);
    assert.ok(channelDistance(theme.rowNew, theme.background) >= 8, `new vs background (dark=${isDark}): ${theme.rowNew} / ${theme.background}`);
    assert.ok(channelDistance(theme.rowMuted, theme.background) >= 8, `striped vs background (dark=${isDark}): ${theme.rowMuted} / ${theme.background}`);
  }
});

test("pending new rows keep their own colour when they hold the active cursor", () => {
  const theme = { background: "bg-base", rowMuted: "row-muted", rowNew: "row-new", rowDeleted: "row-deleted", cellActive: "active-blue", cellSelected: "selected-blue" };
  const newRow = { displayIndex: 0, isDeleted: false, isNew: true, isDraft: false };
  const baseRow = { displayIndex: 0, isDeleted: false, isNew: false, isDraft: false };

  // 光标总在新行上（新增后立即进入编辑），活动行底色不得盖掉「这行还没保存」
  assert.equal(resolveCanvasDataGridRowBase(theme, newRow, { isActive: true }), "row-new");
  assert.equal(resolveCanvasDataGridRowFill(theme, "row-new", { isActive: true, isDeleted: false, isSelected: false, isNew: true }), "row-new");
  // 对照：普通行的活动底色与选中底色保持不变
  assert.equal(resolveCanvasDataGridRowFill(theme, "bg-base", { isActive: true, isDeleted: false, isSelected: false }), "active-blue");
  assert.equal(resolveCanvasDataGridRowFill(theme, "row-new", { isActive: true, isDeleted: false, isSelected: true, isNew: true }), "selected-blue");
});

test("data grid paint theme uses the resolved striped row token", () => {
  const getVar = (name: string) => (name === "--data-grid-row-muted-bg" ? "rgb(235, 239, 244)" : "");

  assert.equal(resolveDataGridPaintTheme({ getVar, isDark: false }).rowMuted, "rgb(235, 239, 244)");
});

test("data grid paint theme resolves cellDirty token", () => {
  const getVar = (name: string) => (name === "--data-grid-cell-dirty-bg" ? "rgb(166, 210, 255)" : "");

  assert.equal(resolveDataGridPaintTheme({ getVar, isDark: false }).cellDirty, "rgb(166, 210, 255)");
});

test("canvas row base respects stripedRows option", () => {
  const theme = {
    background: "bg-base",
    rowMuted: "row-muted",
    rowNew: "row-new",
    rowDeleted: "row-deleted",
  };

  const evenRow = { displayIndex: 0, isDeleted: false, isNew: false, isDraft: false };
  const oddRow = { displayIndex: 1, isDeleted: false, isNew: false, isDraft: false };
  const newRow = { displayIndex: 0, isDeleted: false, isNew: true, isDraft: false };

  // With stripedRows enabled (default or explicit true)
  assert.equal(resolveCanvasDataGridRowBase(theme, evenRow, { isActive: false }), "bg-base");
  assert.equal(resolveCanvasDataGridRowBase(theme, oddRow, { isActive: false }), "row-muted");
  assert.equal(resolveCanvasDataGridRowBase(theme, oddRow, { isActive: false, stripedRows: true }), "row-muted");

  // With stripedRows disabled
  assert.equal(resolveCanvasDataGridRowBase(theme, evenRow, { isActive: false, stripedRows: false }), "bg-base");
  assert.equal(resolveCanvasDataGridRowBase(theme, oddRow, { isActive: false, stripedRows: false }), "bg-base");

  // New row takes precedence when not active
  assert.equal(resolveCanvasDataGridRowBase(theme, newRow, { isActive: false, stripedRows: false }), "row-new");
  assert.equal(resolveCanvasDataGridRowBase(theme, newRow, { isActive: false, stripedRows: true }), "row-new");
});

test("drawBooleanCheckbox renders checked and unchecked state with clean background and border", () => {
  interface CanvasCall {
    method: string;
    args: unknown[];
  }
  const calls: CanvasCall[] = [];
  const fakeCtx = {
    lineWidth: 1,
    fillStyle: "",
    strokeStyle: "",
    fillRect: (x: number, y: number, w: number, h: number) => {
      calls.push({ method: "fillRect", args: [x, y, w, h] });
    },
    strokeRect: (x: number, y: number, w: number, h: number) => {
      calls.push({ method: "strokeRect", args: [x, y, w, h] });
    },
    beginPath: () => {
      calls.push({ method: "beginPath", args: [] });
    },
    moveTo: (x: number, y: number) => {
      calls.push({ method: "moveTo", args: [x, y] });
    },
    lineTo: (x: number, y: number) => {
      calls.push({ method: "lineTo", args: [x, y] });
    },
    stroke: () => {
      calls.push({ method: "stroke", args: [] });
    },
  } as unknown as CanvasRenderingContext2D;

  const theme = {
    background: "#ffffff",
    foreground: "#111111",
    mutedForeground: "#888888",
    primary: "#000000",
  } as unknown as Parameters<typeof drawBooleanCheckbox>[1]["theme"];

  // Unchecked state: clean background fill and muted border
  calls.length = 0;
  drawBooleanCheckbox(fakeCtx, {
    drawX: 0,
    y: 0,
    colWidth: 60,
    scaleX: 1,
    scaleY: 1,
    theme,
    checked: false,
  });
  assert.equal(fakeCtx.fillStyle, "#ffffff");
  assert.equal(fakeCtx.strokeStyle, "#888888");
  assert.equal(fakeCtx.lineWidth, 1);
  assert.ok(calls.some((c) => c.method === "fillRect"));
  assert.ok(calls.some((c) => c.method === "strokeRect"));
  assert.ok(!calls.some((c) => c.method === "stroke"));

  // Checked state: clean background fill, foreground border, and checkmark stroke
  calls.length = 0;
  drawBooleanCheckbox(fakeCtx, {
    drawX: 0,
    y: 0,
    colWidth: 60,
    scaleX: 1,
    scaleY: 1,
    theme,
    checked: true,
  });
  assert.equal(fakeCtx.fillStyle, "#ffffff");
  assert.equal(fakeCtx.strokeStyle, "#111111");
  assert.equal(fakeCtx.lineWidth, 1);
  assert.ok(calls.some((c) => c.method === "fillRect"));
  assert.ok(calls.some((c) => c.method === "strokeRect"));
  assert.ok(calls.some((c) => c.method === "stroke"));
});

