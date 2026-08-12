import { describe, expect, it } from "vitest";
import type { CompletionAssistantCandidate, TreeNode } from "@/types/database";
import { buildPackageMemberNodes, markPackageNodesExpandable } from "@/lib/sidebar/packageMembers";

function packageNode(): TreeNode {
  return {
    id: "conn:db:schema:package:business_api",
    label: "business_api",
    type: "package",
    objectName: "business_api",
    connectionId: "conn",
    database: "db",
    schema: "app_schema",
    valid: false,
  };
}

describe("package member tree", () => {
  it("marks package specifications as expandable without changing other objects", () => {
    const nodes: TreeNode[] = [packageNode(), { id: "body", label: "business_api", type: "package-body" }, { id: "proc", label: "standalone", type: "procedure" }];
    const result = markPackageNodesExpandable(nodes);

    expect(result[0]?.children).toEqual([]);
    expect(result[1]?.children).toBeUndefined();
    expect(result[2]?.children).toBeUndefined();
  });

  it("builds public procedure and function children with overload identities", () => {
    const candidates: CompletionAssistantCandidate[] = [
      { name: "calculate", kind: "procedure", signature: "p_value IN INT" },
      { name: "calculate", kind: "procedure", signature: "p_value IN VARCHAR" },
      { name: "lookup", kind: "function", signature: null, data_type: "VARCHAR" },
      { name: "ignored_table", kind: "table" },
    ];
    const result = buildPackageMemberNodes(packageNode(), candidates, "xugu");

    expect(result.map((node) => [node.type, node.label, node.objectCount])).toEqual([
      ["group-procedures", "tree.procedures", 2],
      ["group-functions", "tree.functions", 1],
    ]);
    expect(result[0]?.children?.map((node) => node.label)).toEqual(["calculate(p_value IN INT)", "calculate(p_value IN VARCHAR)"]);
    expect(result[1]?.children?.map((node) => node.label)).toEqual(["lookup"]);
    expect(result.flatMap((node) => node.children ?? []).every((node) => node.parentName === "business_api" && node.parentSchema === "app_schema" && node.parentType === "package" && node.valid === false)).toBe(true);
    expect(new Set(result.flatMap((node) => node.children ?? []).map((node) => node.id)).size).toBe(3);
  });

  it("keeps package body source metadata on the package without adding a duplicate body node", () => {
    const node = { ...packageNode(), xuguPackageBodyAvailable: true, xuguPackageBodyValid: false };
    const result = buildPackageMemberNodes(node, [{ name: "calculate", kind: "procedure", signature: null }], "xugu");

    expect(result.map((child) => [child.type, child.label])).toEqual([["group-procedures", "tree.procedures"]]);
    expect(result[0]?.children).toHaveLength(1);
    expect(result.some((child) => child.type === "package-body")).toBe(false);
  });

  it("deduplicates exact duplicate metadata without merging case-distinct members", () => {
    const candidates: CompletionAssistantCandidate[] = [
      { name: "MixedCase", kind: "function", signature: "p INT" },
      { name: "MixedCase", kind: "function", signature: "p INT" },
      { name: "MIXEDCASE", kind: "function", signature: "p INT" },
      { name: "", kind: "procedure" },
    ];
    const result = buildPackageMemberNodes(packageNode(), candidates, "xugu");

    expect(result.flatMap((node) => node.children ?? []).map((node) => node.objectName)).toEqual(["MixedCase", "MIXEDCASE"]);
  });

  it("keeps non-Xugu package members flat", () => {
    const result = buildPackageMemberNodes(
      packageNode(),
      [
        { name: "calculate", kind: "procedure", signature: null },
        { name: "lookup", kind: "function", signature: null },
      ],
      "oracle",
    );

    expect(result.map((node) => [node.type, node.label])).toEqual([
      ["procedure", "calculate"],
      ["function", "lookup"],
    ]);
  });
});
