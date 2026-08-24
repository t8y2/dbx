import { describe, expect, it } from "vitest";
import { structureColumnSelectionRange } from "@/lib/table/tableStructureEditorState";

function columnsOf(...ids: string[]) {
  return ids.map((id) => ({ id, markedForDrop: id.startsWith("drop:") }));
}

describe("structureColumnSelectionRange", () => {
  it("returns the contiguous range between anchor and current row in visible order", () => {
    const columns = columnsOf("a", "b", "c", "d");
    expect(structureColumnSelectionRange(columns, "a", "c")).toEqual(["a", "b", "c"]);
  });

  it("supports a backwards shift-click (anchor below the current row)", () => {
    const columns = columnsOf("a", "b", "c", "d");
    expect(structureColumnSelectionRange(columns, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("drops rows marked for drop from the range but keeps the span boundaries", () => {
    const columns = columnsOf("a", "drop:b", "c");
    expect(structureColumnSelectionRange(columns, "a", "c")).toEqual(["a", "c"]);
  });

  it("falls back to the clicked row when the anchor no longer exists", () => {
    const columns = columnsOf("a", "b");
    expect(structureColumnSelectionRange(columns, "missing", "b")).toEqual(["b"]);
  });

  it("returns an empty range when the clicked row no longer exists", () => {
    const columns = columnsOf("a", "drop:b");
    expect(structureColumnSelectionRange(columns, "a", "missing")).toEqual([]);
  });

  it("keeps the span up to a drop-marked clicked row, excluding the row itself", () => {
    // The component guards clicks on drop-marked rows before they reach this
    // helper; a stale range still resolves like the object browser does.
    const columns = columnsOf("a", "drop:b", "c");
    expect(structureColumnSelectionRange(columns, "c", "drop:b")).toEqual(["c"]);
  });
});
