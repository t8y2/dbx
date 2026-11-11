import { describe, expect, it } from "vitest";
import type { SidebarLayout } from "@/types/database";
import { mergeSidebarLayoutConflict } from "@/lib/sidebar/sidebarLayout";

const connections = ["a", "b"];

function ungrouped(): SidebarLayout {
  return {
    groups: [],
    order: [
      { type: "connection", id: "a" },
      { type: "connection", id: "b" },
    ],
  };
}

describe("mergeSidebarLayoutConflict", () => {
  it("keeps an external MCP group while applying a local move", () => {
    const local: SidebarLayout = {
      groups: [{ id: "local", name: "Local", collapsed: false }],
      order: [
        { type: "connection", id: "a" },
        { type: "group", id: "local", children: [{ type: "connection", id: "b" }] },
      ],
    };
    const remote: SidebarLayout = {
      groups: [{ id: "mcp", name: "MCP", collapsed: false }],
      order: [
        { type: "group", id: "mcp", children: [{ type: "connection", id: "a" }] },
        { type: "connection", id: "b" },
      ],
    };

    const merged = mergeSidebarLayoutConflict(ungrouped(), local, remote, connections);

    expect(merged.groups.map((group) => group.id).sort()).toEqual(["local", "mcp"]);
    const remoteGroup = merged.order.find((entry) => entry.type === "group" && entry.id === "mcp");
    const localGroup = merged.order.find((entry) => entry.type === "group" && entry.id === "local");
    expect(remoteGroup).toMatchObject({ children: [{ type: "connection", id: "a" }] });
    expect(localGroup).toMatchObject({ children: [{ type: "connection", id: "b" }] });
  });

  it("does not reapply a local placement that did not change", () => {
    const remote: SidebarLayout = {
      groups: [{ id: "mcp", name: "MCP", collapsed: false }],
      order: [{ type: "group", id: "mcp", children: [{ type: "connection", id: "a" }] }],
    };
    const local: SidebarLayout = {
      groups: [{ id: "local", name: "Local", collapsed: false }],
      order: [{ type: "group", id: "local", children: [{ type: "connection", id: "b" }] }],
    };

    const merged = mergeSidebarLayoutConflict(ungrouped(), local, remote, connections);

    expect(merged.order).toContainEqual({
      type: "group",
      id: "mcp",
      children: [{ type: "connection", id: "a" }],
    });
    expect(merged.order).toContainEqual({
      type: "group",
      id: "local",
      children: [{ type: "connection", id: "b" }],
    });
  });
});
