import { describe, expect, it } from "vitest";
import { isTreeGroupNodeType } from "@/lib/sidebar/treeNodeGroup";

describe("isTreeGroupNodeType", () => {
  it("recognizes Xugu table child groups as translated tree groups", () => {
    expect(isTreeGroupNodeType("group-constraints")).toBe(true);
    expect(isTreeGroupNodeType("group-table-partitions")).toBe(true);
    expect(isTreeGroupNodeType("group-table-subpartitions")).toBe(true);
  });

  it("does not classify Xugu child objects as groups", () => {
    expect(isTreeGroupNodeType("constraint")).toBe(false);
    expect(isTreeGroupNodeType("partition")).toBe(false);
    expect(isTreeGroupNodeType("subpartition")).toBe(false);
  });
});
