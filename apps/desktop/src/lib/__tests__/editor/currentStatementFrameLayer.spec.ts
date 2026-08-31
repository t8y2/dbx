import { describe, expect, it, vi } from "vitest";
import { Text } from "@codemirror/state";
import { currentStatementFrameLayer, currentStatementFrameRect, FRAME_INSET_PX, MAX_FRAME_STATEMENT_LINES } from "@/lib/editor/codemirrorCurrentStatementFrameLayer";

interface CoordRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  height: number;
}

interface LineBlock {
  from: number;
  length: number;
  top: number;
  bottom: number;
  height: number;
}

interface ViewLike {
  coordsAtPos: (pos: number, side?: -1 | 1) => CoordRect | null;
  contentDOM: { getBoundingClientRect(): DOMRect };
  defaultLineHeight: number;
  lineBlockAt: (pos: number) => LineBlock;
  defaultCharacterWidth: number;
  state: { doc: ReturnType<typeof Text.of> };
  scrollDOM: { scrollLeft: number; scrollTop: number; getBoundingClientRect(): DOMRect };
  scaleX: number;
  scaleY: number;
}

const CHAR_WIDTH = 9;
const LINE_HEIGHT = 20;
const BASE_TOP = 112; // typical editor top on screen

interface BuildViewOptions {
  wrapAtColumns?: number;
  viewportColumns?: number;
}

function buildView(lines: string[], scrollTop = 0, coordsAtPosNull: ((pos: number, side: -1 | 1) => boolean) | null = null, options: BuildViewOptions = {}): ViewLike {
  const doc = Text.of(lines);
  const wrapAtColumns = options.wrapAtColumns;
  const visualRows = lines.map((line) => (wrapAtColumns ? Math.max(1, Math.ceil(line.length / wrapAtColumns)) : 1));
  const lineTops: number[] = [];
  let nextLineTop = 0;
  for (const rows of visualRows) {
    lineTops.push(nextLineTop);
    nextLineTop += rows * LINE_HEIGHT;
  }
  const viewportWidth = options.viewportColumns ? options.viewportColumns * CHAR_WIDTH : 1000;
  const lineTop = (pos: number) => {
    const line = doc.lineAt(pos);
    return lineTops[line.number - 1];
  };
  return {
    contentDOM: {
      getBoundingClientRect: () => ({ left: 0, top: BASE_TOP, right: viewportWidth, bottom: 1000, width: viewportWidth, height: 1000 }) as DOMRect,
    },
    defaultCharacterWidth: CHAR_WIDTH,
    defaultLineHeight: LINE_HEIGHT,
    lineBlockAt(pos: number): LineBlock {
      const top = lineTop(pos);
      const line = doc.lineAt(pos);
      const height = visualRows[line.number - 1] * LINE_HEIGHT;
      return { from: line.from, length: line.length, top, bottom: top + height, height };
    },
    state: { doc },
    scaleX: 1,
    scaleY: 1,
    scrollDOM: {
      scrollLeft: 0,
      scrollTop,
      getBoundingClientRect: () => ({ left: 0, top: BASE_TOP, right: viewportWidth, bottom: 1000, width: viewportWidth, height: 1000 }) as DOMRect,
    },
    coordsAtPos(pos: number, side: -1 | 1 = 1): CoordRect | null {
      if (coordsAtPosNull?.(pos, side)) return null;
      const line = doc.lineAt(pos);
      const offset = pos - line.from;
      const characterOffset = side === -1 ? Math.max(0, offset - 1) : Math.min(offset, Math.max(0, line.length - 1));
      const visualRow = wrapAtColumns ? Math.floor(characterOffset / wrapAtColumns) : 0;
      const col = wrapAtColumns ? characterOffset % wrapAtColumns : characterOffset;
      const left = col * CHAR_WIDTH;
      const top = lineTop(pos) + visualRow * LINE_HEIGHT;
      // Screen coords = content pos - scrollTop + baseTop
      return { left, right: left + CHAR_WIDTH, top: top - scrollTop + BASE_TOP, bottom: top + LINE_HEIGHT - scrollTop + BASE_TOP, height: LINE_HEIGHT };
    },
  };
}

describe("currentStatementFrameRect", () => {
  it("returns null for an empty or invalid range", () => {
    const view = buildView(["SELECT 1"]);
    expect(currentStatementFrameRect(view, 3, 3)).toBeNull();
    expect(currentStatementFrameRect(view, 5, 2)).toBeNull();
    expect(currentStatementFrameRect(view, 0, 99)).toBeNull();
    expect(currentStatementFrameRect(view, 4, 8)).not.toBeNull();
  });

  it("uses coordsAtPos for vertical bounds", () => {
    const view = buildView(["SELECT 1"]);
    const rect = currentStatementFrameRect(view, 0, 8);
    expect(rect).not.toBeNull();
    expect(rect!.left).toBe(0 - FRAME_INSET_PX);
    expect(rect!.width).toBe(8 * CHAR_WIDTH + FRAME_INSET_PX * 2);
    expect(rect!.top).toBe(0 - FRAME_INSET_PX);
    expect(rect!.height).toBe(LINE_HEIGHT + FRAME_INSET_PX * 2);
  });

  it("spans a multi-line statement as one continuous rectangle", () => {
    const view = buildView(["SELECT a,", "b", "FROM t"]);
    const to = "SELECT a,\nb\nFROM t".length;
    const rect = currentStatementFrameRect(view, 0, to);
    expect(rect).not.toBeNull();
    expect(rect!.top).toBe(0 - FRAME_INSET_PX);
    expect(rect!.height).toBe(3 * LINE_HEIGHT + FRAME_INSET_PX * 2);
    expect(rect!.width).toBe(9 * CHAR_WIDTH + FRAME_INSET_PX * 2);
  });

  it("covers every visual row of one soft-wrapped logical line", () => {
    const sql = `SELECT ${"x".repeat(20)}`;
    const view = buildView([sql], 0, null, { wrapAtColumns: 10, viewportColumns: 10 });

    const rect = currentStatementFrameRect(view, 0, sql.length);

    expect(rect).not.toBeNull();
    expect(rect!.width).toBe(10 * CHAR_WIDTH + FRAME_INSET_PX * 2);
    expect(rect!.height).toBe(3 * LINE_HEIGHT + FRAME_INSET_PX * 2);
  });

  it("does not widen a short statement that stays on one visual row of a wrapped logical line", () => {
    const statement = "SELECT 1;";
    const view = buildView([`${statement} ${"x".repeat(20)}`], 0, null, { wrapAtColumns: 10, viewportColumns: 10 });

    const rect = currentStatementFrameRect(view, 0, statement.length);

    expect(rect).not.toBeNull();
    expect(rect!.width).toBe(statement.length * CHAR_WIDTH + FRAME_INSET_PX * 2);
    expect(rect!.height).toBe(LINE_HEIGHT + FRAME_INSET_PX * 2);
  });

  it("uses the visual viewport width when one logical line in a multi-line statement wraps", () => {
    const lines = ["SELECT 1", `  ${"x".repeat(23)}`, "FROM t"];
    const view = buildView(lines, 0, null, { wrapAtColumns: 10, viewportColumns: 10 });

    const rect = currentStatementFrameRect(view, 0, view.state.doc.length);

    expect(rect).not.toBeNull();
    expect(rect!.width).toBe(10 * CHAR_WIDTH + FRAME_INSET_PX * 2);
    expect(rect!.height).toBe(5 * LINE_HEIGHT + FRAME_INSET_PX * 2);
  });

  it("keeps soft-wrapped frame probes constant for a very long logical line", () => {
    const shortView = buildView(["x".repeat(201)], 0, null, { wrapAtColumns: 100, viewportColumns: 100 });
    const longSql = "x".repeat(1_000_001);
    const longView = buildView([longSql], 0, null, { wrapAtColumns: 100, viewportColumns: 100 });
    const shortCoords = vi.spyOn(shortView, "coordsAtPos");
    const longCoords = vi.spyOn(longView, "coordsAtPos");

    currentStatementFrameRect(shortView, 0, shortView.state.doc.length);
    const rect = currentStatementFrameRect(longView, 0, longSql.length);

    expect(rect?.width).toBe(100 * CHAR_WIDTH + FRAME_INSET_PX * 2);
    expect(rect?.height).toBe(Math.ceil(longSql.length / 100) * LINE_HEIGHT + FRAME_INSET_PX * 2);
    expect(longCoords).toHaveBeenCalledTimes(shortCoords.mock.calls.length);
    expect(longCoords.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("frames a statement interrupted by a blank line", () => {
    const view = buildView(["SELECT a", "", "FROM t"]);
    const rect = currentStatementFrameRect(view, 0, view.state.doc.length);
    expect(rect).not.toBeNull();
    expect(rect!.top).toBe(0 - FRAME_INSET_PX);
    expect(rect!.height).toBe(3 * LINE_HEIGHT + FRAME_INSET_PX * 2);
  });

  it("bottoms at the last statement line, not the next line", () => {
    const view = buildView(["SELECT 1;", "SELECT 2"]);
    const rect = currentStatementFrameRect(view, 0, 9);
    expect(rect).not.toBeNull();
    expect(rect!.height).toBe(LINE_HEIGHT + FRAME_INSET_PX * 2);
  });

  it("produces the same frame regardless of scroll position", () => {
    const lines = ["-- header", "SELECT a,", "b,", "c,", "FROM t;"];
    const from = Text.of(lines).line(2).from;
    const to = Text.of(lines).line(5).to;

    // No scroll
    const view1 = buildView(lines, 0);
    const rect1 = currentStatementFrameRect(view1, from, to);
    expect(rect1).not.toBeNull();
    expect(rect1!.top + FRAME_INSET_PX).toBe(LINE_HEIGHT);
    expect(rect1!.height).toBe(4 * LINE_HEIGHT + FRAME_INSET_PX * 2);

    // Scrolled down 200px
    const view2 = buildView(lines, 200);
    const rect2 = currentStatementFrameRect(view2, from, to);
    expect(rect2).not.toBeNull();
    expect(rect2!.top).toBe(rect1!.top);
    expect(rect2!.height).toBe(rect1!.height);
  });

  it("falls back to lineBlockAt when coordsAtPos returns null for off-viewport start", () => {
    // Statement spans lines 2-5. coordsAtPos returns null for the start (far off-screen above).
    const lines = ["-- header", "SELECT a,", "b,", "c,", "FROM t;"];
    const from = Text.of(lines).line(2).from;
    const to = Text.of(lines).line(5).to;

    const view = buildView(lines, 200, (pos, side) => pos === from && side === 1);

    const rect = currentStatementFrameRect(view, from, to);
    expect(rect).not.toBeNull();
    // Fallback: lineBlockAt(from).top = 1 * LINE_HEIGHT = 20
    expect(rect!.top + FRAME_INSET_PX).toBe(LINE_HEIGHT);
    // Bottom uses coordsAtPos: (4 * LINE_HEIGHT) - 200 + BASE_TOP - BASE_TOP + 200 = 4 * LINE_HEIGHT
    expect(rect!.height).toBe(4 * LINE_HEIGHT + FRAME_INSET_PX * 2);
  });

  it("keeps a wrapped line full-width when its coordinates are off-viewport", () => {
    const sql = `SELECT ${"x".repeat(20)}`;
    const view = buildView([sql], 200, () => true, { wrapAtColumns: 10, viewportColumns: 10 });

    const rect = currentStatementFrameRect(view, 0, sql.length);

    expect(rect).not.toBeNull();
    expect(rect!.width).toBe(10 * CHAR_WIDTH + FRAME_INSET_PX * 2);
    expect(rect!.height).toBe(3 * LINE_HEIGHT + FRAME_INSET_PX * 2);
  });

  it("handles both start and end off-viewport (deep scroll)", () => {
    // 100 lines; statement spans lines 48-73. Scroll so both are off-screen.
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      if (i === 48) lines.push("CREATE TABLE t (");
      else if (i >= 49 && i <= 72) lines.push("  col" + i + " INT,");
      else if (i === 73) lines.push(") ENGINE=InnoDB;");
      else lines.push("-- line " + i);
    }
    const from = Text.of(lines).line(48).from;
    const to = Text.of(lines).line(73).to;

    // coordsAtPos returns null for both start and end (far off-screen)
    const view = buildView(lines, 2000, (pos, side) => (pos === from && side === 1) || (pos === to && side === -1));

    const rect = currentStatementFrameRect(view, from, to);
    expect(rect).not.toBeNull();
    // top = lineBlockAt(48).top = 47 * LINE_HEIGHT
    expect(rect!.top + FRAME_INSET_PX).toBe(47 * LINE_HEIGHT);
    // bottom = lineBlockAt(73).bottom = 73 * LINE_HEIGHT
    const expectedHeight = (73 - 47) * LINE_HEIGHT + FRAME_INSET_PX * 2;
    expect(rect!.height).toBe(expectedHeight);
  });

  it("skips huge multi-thousand-line statements instead of probing every line (dbx#7226)", () => {
    // A large Oracle package body is parsed as one statement spanning the
    // whole file. Without a cap, this loop would issue two coordsAtPos
    // calls per logical line, freezing the UI on every scroll frame.
    const lineCount = MAX_FRAME_STATEMENT_LINES + 2000;
    const lines = Array.from({ length: lineCount }, (_, i) => `  proc_body_line_${i};`);
    const view = buildView(lines);
    const coords = vi.spyOn(view, "coordsAtPos");

    const rect = currentStatementFrameRect(view, 0, view.state.doc.length);

    expect(rect).toBeNull();
    expect(coords).not.toHaveBeenCalled();
  });

  it("still frames a statement right at the line-count cap", () => {
    const lines = Array.from({ length: MAX_FRAME_STATEMENT_LINES + 1 }, (_, i) => `-- line ${i}`);
    const view = buildView(lines);

    const rect = currentStatementFrameRect(view, 0, view.state.doc.length);

    expect(rect).not.toBeNull();
  });
});

describe("currentStatementFrameLayer", () => {
  it("renders above line decorations so active-line backgrounds cannot cover the frame", () => {
    const layer = vi.fn((config) => config);
    const RectangleMarker = vi.fn();

    currentStatementFrameLayer({ layer, RectangleMarker } as never, () => ({ from: 0, to: 1 }));

    expect(layer).toHaveBeenCalledWith(expect.objectContaining({ above: true, class: "cm-db-currentStatementFrameLayer" }));
  });
});
