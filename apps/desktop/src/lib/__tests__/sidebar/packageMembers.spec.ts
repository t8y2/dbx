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
    const result = buildPackageMemberNodes(packageNode(), candidates);

    expect(result.map((node) => [node.type, node.label])).toEqual([
      ["procedure", "calculate(p_value IN INT)"],
      ["procedure", "calculate(p_value IN VARCHAR)"],
      ["function", "lookup"],
    ]);
    expect(result.every((node) => node.parentName === "business_api" && node.parentSchema === "app_schema" && node.parentType === "package" && node.valid === false)).toBe(true);
    expect(new Set(result.map((node) => node.id)).size).toBe(3);
  });

  it("deduplicates exact duplicate metadata without merging case-distinct members", () => {
    const candidates: CompletionAssistantCandidate[] = [
      { name: "MixedCase", kind: "function", signature: "p INT" },
      { name: "MixedCase", kind: "function", signature: "p INT" },
      { name: "MIXEDCASE", kind: "function", signature: "p INT" },
      { name: "", kind: "procedure" },
    ];
    const result = buildPackageMemberNodes(packageNode(), candidates);

    expect(result.map((node) => node.objectName)).toEqual(["MixedCase", "MIXEDCASE"]);
  });
});
