import { describe, expect, it } from "vitest";
import { sidebarTreeSecondaryValue } from "@/lib/sidebar/sidebarTreeLabel";
import type { TreeNode } from "@/types/database";

describe("sidebar tree labels", () => {
  it("uses the same dialect-specific TYPE labels for rendering and width measurement", () => {
    const node: TreeNode = { id: "type", type: "type", label: "T", customTypeKind: "object" };
    const t = (key: string) => key;
    expect(sidebarTreeSecondaryValue(node, t, "oracle")).toBe("oracleType.kinds.object");
    expect(sidebarTreeSecondaryValue(node, t, "oceanbase-oracle")).toBe("oracleType.kinds.object");
    expect(sidebarTreeSecondaryValue(node, t, "postgres")).toBe("customType.kinds.object");
    expect(sidebarTreeSecondaryValue(node, t)).toBe("customType.kinds.object");
  });
});
