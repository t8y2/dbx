import { describe, expect, it } from "vitest";
import { filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import type { TreeNode } from "@/types/database";

// 复现 issue #11386：「job」搜索命中多张表时，置顶表（sys_job_log）被按匹配
// 得分的重排压到了匹配度更高的兄弟节点（job_queue，前缀匹配）之后。
// store 已把置顶节点排在兄弟列表最前，搜索投影必须保持这一优先级。

/** 构造一张搜索结果里的表节点；pinned 为 true 时表示用户已置顶。 */
function table(id: string, label: string, pinned?: boolean): TreeNode {
  return { id, label, type: "table", connectionId: "conn", database: "app", schema: "public", ...(pinned ? { pinned: true } : {}) };
}

/** 构造承载表节点的 schema 节点（其 label 不参与「job」匹配，仅作为祖先路径保留）。 */
function schema(children: TreeNode[]): TreeNode {
  return { id: "conn:app:public", label: "public", type: "schema", connectionId: "conn", database: "app", isExpanded: true, children };
}

function childLabels(nodes: TreeNode[]): string[] {
  return (nodes[0]?.children ?? []).map((node) => node.label);
}

describe("sidebar search pinned ordering", () => {
  it("keeps a pinned table above a better-scoring unpinned sibling", () => {
    // job_queue 是前缀匹配（得分 90），sys_job_log 仅为词首匹配（80）但已置顶。
    const tree = [schema([table("t1", "job_queue"), table("t2", "sys_job_log", true), table("t3", "qrtz_job_details")])];

    expect(childLabels(filterSidebarTree(tree, "job", new Set()))).toEqual(["sys_job_log", "job_queue", "qrtz_job_details"]);
  });

  it("preserves the custom order of pinned siblings instead of re-ranking them by score", () => {
    // 两张置顶表即便得分不同，也必须保持 store 里用户拖拽出的置顶顺序。
    const tree = [schema([table("t2", "sys_job_log", true), table("t1", "job_queue", true), table("t3", "qrtz_job_details")])];

    expect(childLabels(filterSidebarTree(tree, "job", new Set()))).toEqual(["sys_job_log", "job_queue", "qrtz_job_details"]);
  });

  it("still ranks unpinned matches by match score", () => {
    const tree = [schema([table("t3", "qrtz_job_details"), table("t1", "job_queue")])];

    expect(childLabels(filterSidebarTree(tree, "job", new Set()))).toEqual(["job_queue", "qrtz_job_details"]);
  });
});
