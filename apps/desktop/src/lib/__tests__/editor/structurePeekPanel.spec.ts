import { describe, expect, it } from "vitest";
import { BASE_DIALOG_Z_INDEX } from "@/components/ui/dialog/useDialogLayerOrder";
import { STRUCTURE_PEEK_BASE_Z_INDEX, STRUCTURE_PEEK_DEPTH, STRUCTURE_PEEK_MAX_Z_INDEX, STRUCTURE_PEEK_MIN_HEIGHT, STRUCTURE_PEEK_MIN_WIDTH, clampStructurePeekRect, resizeStructurePeekRect, structurePeekPanelId, structurePeekZIndexesByOrder } from "@/lib/editor/structurePeekPanel";

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

  it("keeps peek panels in a layer band strictly below modal dialogs", () => {
    expect(STRUCTURE_PEEK_MAX_Z_INDEX).toBeLessThan(BASE_DIALOG_Z_INDEX);
    expect(STRUCTURE_PEEK_BASE_Z_INDEX).toBeLessThan(STRUCTURE_PEEK_MAX_Z_INDEX);
    expect(STRUCTURE_PEEK_DEPTH).toBe(STRUCTURE_PEEK_MAX_Z_INDEX - STRUCTURE_PEEK_BASE_Z_INDEX + 1);
  });

  it("stacks open panels by activation order so the last activated one stays on top", () => {
    // Mirror the editor: `open` holds panels back to front, z-index comes from order.
    let open: string[] = [];
    const zIndexOf = (panelId: string) => structurePeekZIndexesByOrder(open.length)[open.indexOf(panelId)]!;
    const openPanel = (panelId: string) => {
      open = [...open, panelId];
    };
    const activate = (panelId: string) => {
      open = [...open.filter((item) => item !== panelId), panelId];
    };

    openPanel("a");
    openPanel("b");
    expect(zIndexOf("b")).toBeGreaterThan(zIndexOf("a"));

    // Repeated A/B/A cycles must not saturate: whichever panel is activated last wins.
    for (let round = 0; round < 24; round += 1) {
      const top = round % 2 === 0 ? "a" : "b";
      const other = top === "a" ? "b" : "a";
      activate(top);
      expect(zIndexOf(top)).toBe(STRUCTURE_PEEK_MAX_Z_INDEX);
      expect(zIndexOf(top)).toBeGreaterThan(zIndexOf(other));
    }
  });

  it("keeps the front panels in strict order no matter how many are open", () => {
    expect(structurePeekZIndexesByOrder(0)).toEqual([]);

    const count = 20;
    const zIndexes = structurePeekZIndexesByOrder(count);
    expect(zIndexes).toHaveLength(count);
    expect(zIndexes[count - 1]).toBe(STRUCTURE_PEEK_MAX_Z_INDEX);
    for (const zIndex of zIndexes) {
      expect(zIndex).toBeGreaterThanOrEqual(STRUCTURE_PEEK_BASE_Z_INDEX);
      expect(zIndex).toBeLessThan(BASE_DIALOG_Z_INDEX);
    }
    // The `STRUCTURE_PEEK_DEPTH` front panels stay strictly ordered; older ones share the base layer.
    for (let index = count - STRUCTURE_PEEK_DEPTH + 1; index < count; index += 1) {
      expect(zIndexes[index]!).toBeGreaterThan(zIndexes[index - 1]!);
    }
  });
});
