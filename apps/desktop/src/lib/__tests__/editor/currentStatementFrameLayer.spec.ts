import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { currentStatementFrameRect, FRAME_INSET_PX } from "@/lib/editor/codemirrorCurrentStatementFrameLayer";

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

function buildView(lines: string[], scrollTop = 0, coordsAtPosNull: ((pos: number, side: -1 | 1) => boolean) | null = null): ViewLike {
  const doc = Text.of(lines);
  const lineTop = (pos: number) => {
    const line = doc.lineAt(pos);
    return (line.number - 1) * LINE_HEIGHT;
  };
  return {
    defaultCharacterWidth: CHAR_WIDTH,
    lineBlockAt(pos: number): LineBlock {
      const top = lineTop(pos);
      const line = doc.lineAt(pos);
      return { from: line.from, length: line.length, top, bottom: top + LINE_HEIGHT, height: LINE_HEIGHT };
    },
    state: { doc },
    scaleX: 1,
    scaleY: 1,
    scrollDOM: {
      scrollLeft: 0,
      scrollTop,
      getBoundingClientRect: () => ({ left: 0, top: BASE_TOP, right: 1000, bottom: 1000, width: 1000, height: 1000 }) as DOMRect,
    },
    coordsAtPos(pos: number, side: -1 | 1 = 1): CoordRect | null {
      if (coordsAtPosNull?.(pos, side)) return null;
      const col = pos - doc.lineAt(pos).from;
      const left = col * CHAR_WIDTH;
      const top = lineTop(pos);
      // Screen coords = content pos - scrollTop + baseTop
      return side === -1
        ? { left: left - CHAR_WIDTH, right: left, top: top - scrollTop + BASE_TOP, bottom: top + LINE_HEIGHT - scrollTop + BASE_TOP, height: LINE_HEIGHT }
        : { left, right: left + CHAR_WIDTH, top: top - scrollTop + BASE_TOP, bottom: top + LINE_HEIGHT - scrollTop + BASE_TOP, height: LINE_HEIGHT };
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
    const view = buildView(lines, 2000, (pos, side) => (pos === from && side === 1) || (pos === to - 1 && side === -1));

    const rect = currentStatementFrameRect(view, from, to);
    expect(rect).not.toBeNull();
    // top = lineBlockAt(48).top = 47 * LINE_HEIGHT
    expect(rect!.top + FRAME_INSET_PX).toBe(47 * LINE_HEIGHT);
    // bottom = lineBlockAt(73).bottom = 73 * LINE_HEIGHT
    const expectedHeight = (73 - 47) * LINE_HEIGHT + FRAME_INSET_PX * 2;
    expect(rect!.height).toBe(expectedHeight);
  });
});
