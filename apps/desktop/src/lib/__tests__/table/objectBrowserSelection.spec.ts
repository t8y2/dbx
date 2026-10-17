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

  it("includes non-table rows inside the span (views, procedures, etc.)", () => {
    const rows = [row("TABLE", "a"), row("VIEW", "v1"), row("PROCEDURE", "p1"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionRange(rows, "TABLE-a", "TABLE-b")).toEqual(["TABLE-a", "VIEW-v1", "PROCEDURE-p1", "TABLE-b"]);
  });

  it("returns just the current row when the anchor is not found in rows", () => {
    const rows = [row("TABLE", "a"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionRange(rows, "missing-anchor", "TABLE-b")).toEqual(["TABLE-b"]);
  });

  it("returns the current non-table row when the anchor is missing", () => {
    const rows = [row("VIEW", "v1"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionRange(rows, "missing-anchor", "VIEW-v1")).toEqual(["VIEW-v1"]);
  });

  it("collapses to a single row when anchor and current are the same row", () => {
    const rows = [row("TABLE", "a"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionRange(rows, "TABLE-a", "TABLE-a")).toEqual(["TABLE-a"]);
  });
});

describe("objectBrowserTableSelectionAnchor", () => {
  it("keeps a visible anchor for any object type", () => {
    const rows = [row("VIEW", "v1"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionAnchor(rows, "VIEW-v1", "TABLE-b")).toBe("VIEW-v1");
  });

  it("uses the current row when the anchor is missing or no longer visible", () => {
    const rows = [row("TABLE", "a"), row("TABLE", "b")];
    expect(objectBrowserTableSelectionAnchor(rows, null, "TABLE-b")).toBe("TABLE-b");
    expect(objectBrowserTableSelectionAnchor(rows, "TABLE-filtered-out", "TABLE-b")).toBe("TABLE-b");
  });
});
