import { describe, expect, it } from "vitest";
import { findConnectionGroupPath } from "@/lib/sidebar/sidebarLayout";
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
