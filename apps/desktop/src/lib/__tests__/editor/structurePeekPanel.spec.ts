import { describe, expect, it } from "vitest";
import { STRUCTURE_PEEK_MIN_HEIGHT, STRUCTURE_PEEK_MIN_WIDTH, clampStructurePeekRect, resizeStructurePeekRect, structurePeekPanelId } from "@/lib/editor/structurePeekPanel";

describe("structurePeekPanel", () => {
  it("builds a stable case-insensitive identity including catalog", () => {
    expect(structurePeekPanelId("Conn", "Db", "Public", "Orders", "Cat")).toBe(structurePeekPanelId("conn", "db", "public", "orders", "cat"));
    expect(structurePeekPanelId("c", "db", "a", "t")).not.toBe(structurePeekPanelId("c", "db", "b", "t"));
    expect(structurePeekPanelId("c", "db", "s", "t", "cat-a")).not.toBe(structurePeekPanelId("c", "db", "s", "t", "cat-b"));
  });

  it("clamps rects inside the viewport with a margin", () => {
    expect(clampStructurePeekRect({ left: -40, top: -20, width: 500, height: 400 }, 800, 600)).toEqual({
      left: 8,
      top: 8,
      width: 500,
      height: 400,
    });
    expect(clampStructurePeekRect({ left: 700, top: 500, width: 500, height: 400 }, 800, 600)).toEqual({
      left: 800 - 8 - 500,
      top: 600 - 8 - 400,
      width: 500,
      height: 400,
    });
  });

  it("enforces minimum size while resizing from the west/north edges", () => {
    const origin = { left: 100, top: 100, width: 400, height: 300 };
    const shrunkWest = resizeStructurePeekRect(origin, "w", 200, 0, 1200, 800);
    expect(shrunkWest.width).toBe(STRUCTURE_PEEK_MIN_WIDTH);
    expect(shrunkWest.left).toBe(100 + 400 - STRUCTURE_PEEK_MIN_WIDTH);

    const shrunkNorth = resizeStructurePeekRect(origin, "n", 0, 200, 1200, 800);
    expect(shrunkNorth.height).toBe(STRUCTURE_PEEK_MIN_HEIGHT);
    expect(shrunkNorth.top).toBe(100 + 300 - STRUCTURE_PEEK_MIN_HEIGHT);
  });

  it("resizes northeast corners without treating n as containing e", () => {
    const origin = { left: 100, top: 100, width: 400, height: 300 };
    const grown = resizeStructurePeekRect(origin, "ne", 50, -40, 1200, 800);
    expect(grown.width).toBe(450);
    expect(grown.height).toBe(340);
    expect(grown.left).toBe(100);
    expect(grown.top).toBe(60);
  });
});
