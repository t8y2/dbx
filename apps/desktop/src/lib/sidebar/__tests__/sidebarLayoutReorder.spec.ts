import { describe, expect, it } from "vitest";

import { reorderEntries, findEntryParentGroupId, type SidebarLayout } from "@/lib/sidebar/sidebarLayout";

function nestedGroupLayout(): SidebarLayout {
  return {
    groups: [
      { id: "P", name: "Parent", collapsed: false },
      { id: "G", name: "SubFolder", collapsed: false },
    ],
    order: [
      {
        type: "group",
        id: "P",
        children: [
          { type: "connection", id: "A" },
          { type: "connection", id: "B" },
          { type: "group", id: "G", children: [{ type: "connection", id: "C" }] },
        ],
      },
      { type: "connection", id: "D" },
      { type: "connection", id: "E" },
    ],
  };
}

describe("findEntryParentGroupId — drag-target parent lookup", () => {
  it("returns the parent group of a nested folder", () => {
    expect(findEntryParentGroupId(nestedGroupLayout().order, "G")).toBe("P");
  });

  it("returns the parent group of a connection inside a nested folder", () => {
    expect(findEntryParentGroupId(nestedGroupLayout().order, "C")).toBe("G");
  });

  it("returns null for a root-level entry", () => {
    expect(findEntryParentGroupId(nestedGroupLayout().order, "D")).toBeNull();
  });

  it("returns undefined for an entry that is not in the layout", () => {
    expect(findEntryParentGroupId(nestedGroupLayout().order, "missing")).toBeUndefined();
  });
});

describe("reorderEntries — moving a folder out of its parent", () => {
  it("moves a nested folder before a root-level connection", () => {
    const result = reorderEntries(nestedGroupLayout(), ["G"], "D", "before");
    expect(result.order).toEqual([
      {
        type: "group",
        id: "P",
        children: [
          { type: "connection", id: "A" },
          { type: "connection", id: "B" },
        ],
      },
      { type: "group", id: "G", children: [{ type: "connection", id: "C" }] },
      { type: "connection", id: "D" },
      { type: "connection", id: "E" },
    ]);
  });

  it("moves a nested folder after the last root-level connection", () => {
    const result = reorderEntries(nestedGroupLayout(), ["G"], "E", "after");
    expect(result.order).toEqual([
      {
        type: "group",
        id: "P",
        children: [
          { type: "connection", id: "A" },
          { type: "connection", id: "B" },
        ],
      },
      { type: "connection", id: "D" },
      { type: "connection", id: "E" },
      { type: "group", id: "G", children: [{ type: "connection", id: "C" }] },
    ]);
  });

  it("moves a nested folder before its own parent group", () => {
    const result = reorderEntries(nestedGroupLayout(), ["G"], "P", "before");
    expect(result.order).toEqual([
      { type: "group", id: "G", children: [{ type: "connection", id: "C" }] },
      {
        type: "group",
        id: "P",
        children: [
          { type: "connection", id: "A" },
          { type: "connection", id: "B" },
        ],
      },
      { type: "connection", id: "D" },
      { type: "connection", id: "E" },
    ]);
  });

  it("keeps a folder inside its parent when dropped inside the parent", () => {
    const result = reorderEntries(nestedGroupLayout(), ["G"], "P", "inside");
    expect(result.order).toEqual(nestedGroupLayout().order);
  });

  it("refuses to drop a folder inside its own descendant", () => {
    const layout: SidebarLayout = {
      groups: [
        { id: "P", name: "Parent", collapsed: false },
        { id: "G", name: "SubFolder", collapsed: false },
      ],
      order: [
        {
          type: "group",
          id: "P",
          children: [{ type: "group", id: "G", children: [{ type: "connection", id: "C" }] }],
        },
      ],
    };
    const result = reorderEntries(layout, ["P"], "G", "inside");
    expect(result.order).toEqual(layout.order);
  });
});
