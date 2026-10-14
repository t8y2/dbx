import { describe, expect, it } from "vitest";
import { filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import type { TreeNode } from "@/types/database";

function connection(id: string, children?: TreeNode[]): TreeNode {
  return { id, label: id, type: "connection", connectionId: id, isExpanded: true, children };
}

function group(id: string, children: TreeNode[]): TreeNode {
  return { id, label: id, type: "connection-group", isExpanded: true, children };
}

describe("sidebar search locked group projection", () => {
  it("keeps connections of a locked group out of the projection", () => {
    // 锁定分组本身不命中搜索词时不得靠子连接命中而浮现。
    const tree = [group("new-insurance", [connection("OB-nprpall-test")]), connection("OB-nprpall-sp")];

    const result = filterSidebarTree(tree, "prpall", new Set(), undefined, { lockedGroupIds: new Set(["new-insurance"]) });

    expect(result.map((node) => node.id)).toEqual(["OB-nprpall-sp"]);
  });

  it("drops a locked group with no self match even when a descendant would match", () => {
    const tree = [group("new-insurance", [connection("OB-nprpall-test")])];

    const result = filterSidebarTree(tree, "prpall", new Set(), undefined, { lockedGroupIds: new Set(["new-insurance"]) });

    expect(result).toEqual([]);
  });

  it("shows a locked group matching by its own label without any contents", () => {
    const tree = [group("new-insurance", [connection("OB-nprpall-test")])];

    const result = filterSidebarTree(tree, "new-insurance", new Set(), undefined, { lockedGroupIds: new Set(["new-insurance"]) });

    expect(result).toHaveLength(1);
    expect(result[0]?.children).toEqual([]);
    expect(result[0]?.isExpanded).toBe(false);
  });

  it("keeps the contents searchable when the group is not locked for this session", () => {
    // 会话内已解锁（集合为空）时行为与普通分组一致，内容可搜索。
    const tree = [group("new-insurance", [connection("OB-nprpall-test")])];

    const result = filterSidebarTree(tree, "prpall", new Set(), undefined, { lockedGroupIds: new Set() });

    expect(result).toHaveLength(1);
    expect(result[0]?.children?.map((node) => node.id)).toEqual(["OB-nprpall-test"]);
    expect(result[0]?.isExpanded).toBe(true);
  });

  it("hides nested database and table matches under a locked group", () => {
    const tree = [
      group("vault", [
        connection("conn", [
          {
            id: "conn:db",
            label: "db",
            type: "database",
            connectionId: "conn",
            children: [{ id: "conn:db:orders", label: "orders", type: "table", connectionId: "conn" }],
          },
        ]),
      ]),
    ];

    const result = filterSidebarTree(tree, "orders", new Set(), undefined, { lockedGroupIds: new Set(["vault"]) });

    expect(result).toEqual([]);
  });

  it("leaves ungrouped connections and unlocked groups untouched", () => {
    const tree = [group("locked", [connection("prpall-hidden")]), group("open", [connection("prpall-visible")]), connection("prpall-root")];

    const result = filterSidebarTree(tree, "prpall", new Set(), undefined, { lockedGroupIds: new Set(["locked"]) });

    expect(result.map((node) => node.id).sort()).toEqual(["open", "prpall-root"]);
    expect(result.find((node) => node.id === "open")?.children?.map((node) => node.id)).toEqual(["prpall-visible"]);
  });

  it("keeps the previous behavior when no locked groups are supplied", () => {
    const tree = [group("new-insurance", [connection("OB-nprpall-test")])];

    const result = filterSidebarTree(tree, "prpall", new Set());

    expect(result).toHaveLength(1);
    expect(result[0]?.children?.map((node) => node.id)).toEqual(["OB-nprpall-test"]);
  });
});
