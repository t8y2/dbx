import { describe, expect, it } from "vitest";
import { buildConnectionPickerRows, connectionPickerSelectableRows, type ConnectionPickerRow } from "@/lib/connection/connectionPickerTree";
import type { SidebarLayout } from "@/types/database";

const connections = [
  { id: "c1", name: "生产 MySQL" },
  { id: "c2", name: "测试 MySQL" },
  { id: "c3", name: "本地 PG" },
  { id: "c4", name: "孤儿连接" },
];

function layout(): SidebarLayout {
  return {
    groups: [
      { id: "g1", name: "生产", collapsed: false },
      { id: "g2", name: "华东", collapsed: false },
    ],
    order: [
      {
        type: "group",
        id: "g1",
        children: [
          { type: "group", id: "g2", children: [{ type: "connection", id: "c1" }] },
          { type: "connection", id: "c2" },
        ],
      },
      { type: "connection", id: "c3" },
    ],
  };
}

function kinds(rows: ConnectionPickerRow[]): string[] {
  return rows.map((row) => `${row.kind}:${row.id}@${row.depth}`);
}

describe("buildConnectionPickerRows", () => {
  it("flattens the layout tree with depths in sidebar order", () => {
    const rows = buildConnectionPickerRows(layout(), connections, new Set(), "");
    expect(kinds(rows)).toEqual(["group:g1@0", "group:g2@1", "connection:c1@2", "connection:c2@1", "connection:c3@0", "connection:c4@0"]);
  });

  it("appends connections missing from the layout at the top level", () => {
    const rows = buildConnectionPickerRows({ groups: [], order: [] }, connections, new Set(), "");
    expect(kinds(rows)).toEqual(["connection:c1@0", "connection:c2@0", "connection:c3@0", "connection:c4@0"]);
  });

  it("hides children of collapsed groups without dropping them from the fallback", () => {
    const rows = buildConnectionPickerRows(layout(), connections, new Set(["g1"]), "");
    expect(kinds(rows)).toEqual(["group:g1@0", "connection:c3@0", "connection:c4@0"]);
    expect(rows[0]?.collapsed).toBe(true);
  });

  it("keeps deeper groups visible when only a nested group is collapsed", () => {
    const rows = buildConnectionPickerRows(layout(), connections, new Set(["g2"]), "");
    expect(kinds(rows)).toEqual(["group:g1@0", "group:g2@1", "connection:c2@1", "connection:c3@0", "connection:c4@0"]);
  });

  it("skips stale layout connection ids that no longer exist", () => {
    const stale: SidebarLayout = { groups: [], order: [{ type: "connection", id: "gone" }] };
    const rows = buildConnectionPickerRows(stale, connections, new Set(), "");
    expect(kinds(rows)).toEqual(["connection:c1@0", "connection:c2@0", "connection:c3@0", "connection:c4@0"]);
  });

  it("filters connections by name and keeps ancestor groups expanded", () => {
    const rows = buildConnectionPickerRows(layout(), connections, new Set(["g1", "g2"]), "本地");
    expect(kinds(rows)).toEqual(["connection:c3@0"]);
  });

  it("matches connections by group path and keeps the hierarchy", () => {
    const rows = buildConnectionPickerRows(layout(), connections, new Set(), "华东");
    expect(kinds(rows)).toEqual(["group:g1@0", "group:g2@1", "connection:c1@2"]);
    expect(rows.every((row) => !row.collapsed)).toBe(true);
  });

  it("matches fallback connections by name during search", () => {
    const rows = buildConnectionPickerRows(layout(), connections, new Set(), "孤儿");
    expect(kinds(rows)).toEqual(["connection:c4@0"]);
  });

  it("returns no rows when nothing matches the query", () => {
    expect(buildConnectionPickerRows(layout(), connections, new Set(), "不存在")).toEqual([]);
  });

  it("prunes groups that hold none of the given connections", () => {
    const onlyC3 = connections.filter((connection) => connection.id === "c3");
    expect(kinds(buildConnectionPickerRows(layout(), onlyC3, new Set(), ""))).toEqual(["connection:c3@0"]);
  });

  it("prunes nested groups without usable descendants even when collapsed", () => {
    const onlyC2 = connections.filter((connection) => connection.id === "c2");
    const rows = buildConnectionPickerRows(layout(), onlyC2, new Set(["g2"]), "");
    expect(kinds(rows)).toEqual(["group:g1@0", "connection:c2@1"]);
  });

  it("falls back to the connection id when the name is empty", () => {
    const rows = buildConnectionPickerRows({ groups: [], order: [] }, [{ id: "c9", name: "" }], new Set(), "");
    expect(rows[0]?.label).toBe("c9");
  });
});

describe("connectionPickerSelectableRows", () => {
  it("keeps only connection rows for keyboard navigation", () => {
    const rows = buildConnectionPickerRows(layout(), connections, new Set(), "");
    expect(connectionPickerSelectableRows(rows).map((row) => row.id)).toEqual(["c1", "c2", "c3", "c4"]);
  });
});
