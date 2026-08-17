import { describe, expect, it } from "vitest";
import { connectionIdsInGroups, deleteGroups, findConnectionGroupPath } from "@/lib/sidebar/sidebarLayout";
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
