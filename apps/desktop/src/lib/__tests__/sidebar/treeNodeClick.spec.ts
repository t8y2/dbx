import { describe, expect, it } from "vitest";
import { objectSourceKindForTreeNode, treeNodeRowAction, treeNodeRowDoubleClickAction } from "@/lib/sidebar/treeNodeClick";

describe("treeNodeClick", () => {
  it("opens synonym nodes as synonym source", () => {
    expect(objectSourceKindForTreeNode("synonym")).toBe("SYNONYM");
    expect(treeNodeRowAction("synonym", false)).toBe("open-source");
  });

  it("only Xugu type nodes open source on single click", () => {
    expect(treeNodeRowAction("type", false, "single", "xugu")).toBe("open-source");
    for (const dbType of ["postgres", "opengauss", "gaussdb", "kingbase", "vastbase", undefined] as const) {
      expect(treeNodeRowAction("type", false, "single", dbType), String(dbType)).toBe("none");
    }
  });

  it("only Xugu type nodes open source on double click", () => {
    expect(treeNodeRowDoubleClickAction("type", false, "double", false, "xugu")).toBe("open-source");
    for (const dbType of ["postgres", "opengauss", "gaussdb", "kingbase", "vastbase", undefined] as const) {
      expect(treeNodeRowDoubleClickAction("type", false, "double", false, dbType), String(dbType)).toBe("none");
    }
  });

  it("keeps source actions for non-type source nodes on PG-family databases", () => {
    for (const type of ["procedure", "function", "trigger", "sequence", "package", "package-body"] as const) {
      expect(treeNodeRowAction(type, false, "single", "postgres"), type).toBe("open-source");
    }
    expect(treeNodeRowAction("type-body", false, "single", "xugu")).toBe("open-source");
  });
});
