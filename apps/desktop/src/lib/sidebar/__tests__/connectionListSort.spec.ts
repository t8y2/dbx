import { describe, expect, it } from "vitest";
import { compareConnectionListNames, sortSidebarOrderEntriesForDisplay } from "@/lib/sidebar/connectionListSort";
import type { SidebarOrderEntry } from "@/types/database";

const connectionNames: Record<string, string> = {
  alpha: "Alpha",
  beta: "Beta",
  gamma: "Gamma",
  zebra: "zebra",
  "alpha-two": "Alpha 2",
};
const groupNames: Record<string, string> = {
  "group-z": "Zeta Group",
  "group-a": "Alpha Group",
  "group-m": "Middle Group",
  nested: "Nested",
};

function connectionNameOf(id: string): string | undefined {
  return connectionNames[id];
}

function groupNameOf(id: string): string | undefined {
  return groupNames[id];
}

function sort(entries: readonly SidebarOrderEntry[], mode: "manual" | "asc" | "desc") {
  return sortSidebarOrderEntriesForDisplay(entries, mode, groupNameOf, connectionNameOf);
}

function ids(entries: readonly SidebarOrderEntry[]): string[] {
  return entries.map((entry) => `${entry.type}:${entry.id}`);
}

describe("compareConnectionListNames", () => {
  it("compares numeric and case-insensitive names like the sidebar", () => {
    expect(compareConnectionListNames("alpha", "Alpha")).toBe(0);
    expect(compareConnectionListNames("Alpha 2", "Alpha 10")).toBeLessThan(0);
  });
});

describe("sortSidebarOrderEntriesForDisplay", () => {
  const layout: SidebarOrderEntry[] = [
    { type: "connection", id: "zebra" },
    {
      type: "group",
      id: "group-z",
      children: [
        { type: "connection", id: "beta" },
        { type: "connection", id: "alpha" },
      ],
    },
    { type: "connection", id: "alpha" },
    { type: "group", id: "group-a", children: [{ type: "connection", id: "gamma" }] },
  ];

  it("returns the input untouched in manual mode", () => {
    expect(sort(layout, "manual")).toBe(layout);
  });

  it("orders connections and sibling groups ascending while preserving group/connection slots", () => {
    const sorted = sort(layout, "asc");

    // Connection slots (0, 2) receive alpha then zebra; group slots (1, 3)
    // receive Alpha Group then Zeta Group.
    expect(ids(sorted)).toEqual(["connection:alpha", "group:group-a", "connection:zebra", "group:group-z"]);
    expect(sorted[1]).toMatchObject({ children: [{ type: "connection", id: "gamma" }] });
    expect(sorted[3]).toMatchObject({
      children: [
        { type: "connection", id: "alpha" },
        { type: "connection", id: "beta" },
      ],
    });
  });

  it("orders connections and sibling groups descending", () => {
    const sorted = sort(layout, "desc");

    expect(ids(sorted)).toEqual(["connection:zebra", "group:group-z", "connection:alpha", "group:group-a"]);
    expect(sorted[1]).toMatchObject({
      children: [
        { type: "connection", id: "beta" },
        { type: "connection", id: "alpha" },
      ],
    });
  });

  it("sorts nested group children recursively", () => {
    const nested: SidebarOrderEntry[] = [
      {
        type: "group",
        id: "group-m",
        children: [
          {
            type: "group",
            id: "nested",
            children: [
              { type: "connection", id: "gamma" },
              { type: "connection", id: "alpha" },
            ],
          },
        ],
      },
    ];

    const sorted = sort(nested, "asc");
    expect(sorted[0]).toMatchObject({
      type: "group",
      id: "group-m",
      children: [
        {
          type: "group",
          id: "nested",
          children: [
            { type: "connection", id: "alpha" },
            { type: "connection", id: "gamma" },
          ],
        },
      ],
    });
  });

  it("sorts legacy connectionIds groups by connection name", () => {
    const legacy: SidebarOrderEntry[] = [{ type: "group", id: "group-z", connectionIds: ["gamma", "alpha", "beta"] }];

    expect(sort(legacy, "asc")).toEqual([{ type: "group", id: "group-z", connectionIds: ["alpha", "beta", "gamma"] }]);
    expect(sort(legacy, "desc")).toEqual([{ type: "group", id: "group-z", connectionIds: ["gamma", "beta", "alpha"] }]);
  });

  it("never mutates the input entries", () => {
    const source: SidebarOrderEntry[] = [
      { type: "connection", id: "zebra" },
      {
        type: "group",
        id: "group-z",
        children: [
          { type: "connection", id: "beta" },
          { type: "connection", id: "alpha" },
        ],
      },
      { type: "connection", id: "alpha" },
    ];

    sort(source, "asc");

    expect(ids(source)).toEqual(["connection:zebra", "group:group-z", "connection:alpha"]);
    expect(source[1]).toMatchObject({
      children: [
        { type: "connection", id: "beta" },
        { type: "connection", id: "alpha" },
      ],
    });
  });

  it("falls back to the entry id for missing names instead of clumping them first", () => {
    const unknown: SidebarOrderEntry[] = [
      { type: "connection", id: "unknown" },
      { type: "connection", id: "alpha" },
    ];

    // Empty-string fallbacks would put `unknown` first in ascending mode.
    expect(ids(sort(unknown, "asc"))).toEqual(["connection:alpha", "connection:unknown"]);
    expect(ids(sort(unknown, "desc"))).toEqual(["connection:unknown", "connection:alpha"]);
  });

  it("keeps original relative order for equal names", () => {
    connectionNames["alpha-copy"] = "Alpha";
    const duplicates: SidebarOrderEntry[] = [
      { type: "connection", id: "alpha-copy" },
      { type: "connection", id: "alpha" },
    ];

    expect(ids(sort(duplicates, "asc"))).toEqual(["connection:alpha-copy", "connection:alpha"]);
    delete connectionNames["alpha-copy"];
  });

  it("returns the input reference when the order is already sorted", () => {
    const alreadySorted: SidebarOrderEntry[] = [
      { type: "connection", id: "alpha" },
      { type: "connection", id: "beta" },
    ];

    expect(sort(alreadySorted, "asc")).toBe(alreadySorted);
  });
});
