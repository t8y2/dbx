import { describe, expect, it } from "vitest";
import { objectBrowserTableSelectionAnchor, objectBrowserTableSelectionRange } from "@/lib/table/objectBrowserSelection";
import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";

function row(type: ObjectBrowserRow["type"], name: string): ObjectBrowserRow {
  return { id: `${type}-${name}`, name, displayName: name, type };
}

describe("objectBrowserTableSelectionRange", () => {
  it("selects every table between anchor and current row, inclusive", () => {
    const rows = [row("TABLE", "a"), row("TABLE", "b"), row("TABLE", "c"), row("TABLE", "d")];
    expect(objectBrowserTableSelectionRange(rows, "TABLE-a", "TABLE-c")).toEqual(["TABLE-a", "TABLE-b", "TABLE-c"]);
  });

  it("supports selecting upward when the current row precedes the anchor", () => {
    const rows = [row("TABLE", "a"), row("TABLE", "b"), row("TABLE", "c"), row("TABLE", "d")];
    expect(objectBrowserTableSelectionRange(rows, "TABLE-d", "TABLE-b")).toEqual(["TABLE-b", "TABLE-c", "TABLE-d"]);
  });

  it("drops non-table rows inside the span, since only tables are selectable", () => {
    const rows = [row("TABLE", "a"), row("VIEW", "v1"), row("PROCEDURE", "p1"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionRange(rows, "TABLE-a", "TABLE-b")).toEqual(["TABLE-a", "TABLE-b"]);
  });

  it("returns just the current row when the anchor is not selectable and current is a table", () => {
    const rows = [row("TABLE", "a"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionRange(rows, "missing-anchor", "TABLE-b")).toEqual(["TABLE-b"]);
  });

  it("returns an empty range when the anchor is missing and current row is not a table", () => {
    const rows = [row("VIEW", "v1"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionRange(rows, "missing-anchor", "VIEW-v1")).toEqual([]);
  });

  it("collapses to a single row when anchor and current are the same table", () => {
    const rows = [row("TABLE", "a"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionRange(rows, "TABLE-a", "TABLE-a")).toEqual(["TABLE-a"]);
  });
});

describe("objectBrowserTableSelectionAnchor", () => {
  it("keeps a visible table anchor", () => {
    const rows = [row("TABLE", "a"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionAnchor(rows, "TABLE-a", "TABLE-b")).toBe("TABLE-a");
  });

  it("uses the current table when the anchor is missing or no longer visible", () => {
    const rows = [row("TABLE", "a"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionAnchor(rows, null, "TABLE-b")).toBe("TABLE-b");
    expect(objectBrowserTableSelectionAnchor(rows, "TABLE-filtered-out", "TABLE-b")).toBe("TABLE-b");
  });
});
