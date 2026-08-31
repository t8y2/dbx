import { describe, expect, it } from "vitest";
import { connectionGroupDestinationRows, connectionGroupIdForSelection, connectionIdsInGroups, deleteGroups, findConnectionGroupPath, reorderEntries } from "@/lib/sidebar/sidebarLayout";
import type { SidebarLayout } from "@/types/database";

const layout: SidebarLayout = {
  groups: [
    { id: "project", name: "Project", collapsed: false },
    { id: "staging", name: "Staging", collapsed: false },
  ],
  order: [
    {
      type: "group",
      id: "project",
      children: [
        {
          type: "group",
          id: "staging",
          children: [{ type: "connection", id: "nested" }],
        },
        { type: "connection", id: "grouped" },
      ],
    },
    { type: "connection", id: "root" },
  ],
};

const dragLayout: SidebarLayout = {
  groups: [
    { id: "alpha", name: "Alpha", collapsed: false },
    { id: "beta", name: "Beta", collapsed: false },
    { id: "nested", name: "Nested", collapsed: false },
  ],
  order: [
    {
      type: "group",
      id: "alpha",
      children: [
        { type: "connection", id: "alpha-first" },
        {
          type: "group",
          id: "nested",
          children: [{ type: "connection", id: "nested-connection" }],
        },
        { type: "connection", id: "alpha-second" },
      ],
    },
    {
      type: "group",
      id: "beta",
      children: [{ type: "connection", id: "beta-connection" }],
    },
  ],
};

describe("findConnectionGroupPath", () => {
  it("returns every containing group from root to leaf", () => {
    expect(findConnectionGroupPath(layout, "nested")).toEqual(["Project", "Staging"]);
    expect(findConnectionGroupPath(layout, "grouped")).toEqual(["Project"]);
  });

  it("distinguishes a top-level connection from a missing connection", () => {
    expect(findConnectionGroupPath(layout, "root")).toEqual([]);
    expect(findConnectionGroupPath(layout, "missing")).toBeNull();
  });
});

describe("connection group deletion", () => {
  it("collects nested connection ids once for overlapping selected groups", () => {
    expect(connectionIdsInGroups(layout, ["project", "staging"])).toEqual(["nested", "grouped"]);
    expect(connectionIdsInGroups(layout, ["staging"])).toEqual(["nested"]);
    expect(connectionIdsInGroups(layout, ["missing"])).toEqual([]);
  });

  it("removes the selected group subtree while promoting all of its connections", () => {
    expect(deleteGroups(layout, ["project"])).toEqual({
      groups: [],
      order: [
        { type: "connection", id: "nested" },
        { type: "connection", id: "grouped" },
        { type: "connection", id: "root" },
      ],
    });
  });

  it("keeps the parent group when only a nested group subtree is deleted", () => {
    expect(deleteGroups(layout, ["staging"])).toEqual({
      groups: [{ id: "project", name: "Project", collapsed: false }],
      order: [
        {
          type: "group",
          id: "project",
          children: [
            { type: "connection", id: "nested" },
            { type: "connection", id: "grouped" },
          ],
        },
        { type: "connection", id: "root" },
      ],
    });
  });

  it("deduplicates overlapping parent and child group deletions", () => {
    expect(deleteGroups(layout, ["project", "staging"])).toEqual({
      groups: [],
      order: [
        { type: "connection", id: "nested" },
        { type: "connection", id: "grouped" },
        { type: "connection", id: "root" },
      ],
    });
  });
});

describe("sorted sidebar move-only drops", () => {
  const preserveSameGroupOrder = { preserveSameGroupOrder: true };

  it("keeps a same-folder connection drop from rewriting hidden manual order", () => {
    expect(reorderEntries(dragLayout, ["alpha-first"], "alpha", "inside", preserveSameGroupOrder)).toBe(dragLayout);
  });

  it("keeps a same-folder multi-selection drop from rewriting hidden manual order", () => {
    expect(reorderEntries(dragLayout, ["alpha-first", "alpha-second"], "alpha", "inside", preserveSameGroupOrder)).toBe(dragLayout);
  });

  it("keeps a same-folder group drop from rewriting hidden manual order", () => {
    expect(reorderEntries(dragLayout, ["nested"], "alpha", "inside", preserveSameGroupOrder)).toBe(dragLayout);
  });

  it("moves cross-folder entries while preserving selected entries already in the target folder", () => {
    expect(reorderEntries(dragLayout, ["alpha-first", "beta-connection"], "alpha", "inside", preserveSameGroupOrder)).toEqual({
      ...dragLayout,
      order: [
        {
          type: "group",
          id: "alpha",
          children: [
            { type: "connection", id: "alpha-first" },
            {
              type: "group",
              id: "nested",
              children: [{ type: "connection", id: "nested-connection" }],
            },
            { type: "connection", id: "alpha-second" },
            { type: "connection", id: "beta-connection" },
          ],
        },
        { type: "group", id: "beta", children: [] },
      ],
    });
  });

  it("preserves ordinary same-folder inside reordering outside move-only mode", () => {
    expect(reorderEntries(dragLayout, ["alpha-first"], "alpha", "inside")).toEqual({
      ...dragLayout,
      order: [
        {
          type: "group",
          id: "alpha",
          children: [
            {
              type: "group",
              id: "nested",
              children: [{ type: "connection", id: "nested-connection" }],
            },
            { type: "connection", id: "alpha-second" },
            { type: "connection", id: "alpha-first" },
          ],
        },
        {
          type: "group",
          id: "beta",
          children: [{ type: "connection", id: "beta-connection" }],
        },
      ],
    });
  });

  it("still moves a group across folders in move-only mode", () => {
    expect(reorderEntries(dragLayout, ["nested"], "beta", "inside", preserveSameGroupOrder)).toEqual({
      ...dragLayout,
      order: [
        {
          type: "group",
          id: "alpha",
          children: [
            { type: "connection", id: "alpha-first" },
            { type: "connection", id: "alpha-second" },
          ],
        },
        {
          type: "group",
          id: "beta",
          children: [
            { type: "connection", id: "beta-connection" },
            {
              type: "group",
              id: "nested",
              children: [{ type: "connection", id: "nested-connection" }],
            },
          ],
        },
      ],
    });
  });
});

describe("connection group selection", () => {
  it("lists nested groups in sidebar order with complete paths", () => {
    expect(connectionGroupDestinationRows(layout)).toEqual([
      { id: "project", name: "Project", depth: 0, path: ["Project"] },
      { id: "staging", name: "Staging", depth: 1, path: ["Project", "Staging"] },
    ]);
  });

  it("uses the focused group or the group containing a focused connection", () => {
    expect(connectionGroupIdForSelection(layout, "staging")).toBe("staging");
    expect(connectionGroupIdForSelection(layout, "nested", "nested")).toBe("staging");
    expect(connectionGroupIdForSelection(layout, "grouped")).toBe("project");
  });

  it("falls back to ungrouped for root or unknown selections", () => {
    expect(connectionGroupIdForSelection(layout, "root", "root")).toBeNull();
    expect(connectionGroupIdForSelection(layout, "missing")).toBeNull();
    expect(connectionGroupIdForSelection(layout)).toBeNull();
  });
});
