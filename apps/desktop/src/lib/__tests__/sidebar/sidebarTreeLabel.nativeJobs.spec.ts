import { describe, expect, it } from "vitest";
import { sidebarTreeDisplayLabel } from "@/lib/sidebar/sidebarTreeLabel";
import type { TreeNode } from "@/types/database";

describe("sidebar tree labels", () => {
  it("translates the native job entry for rendering and width measurement", () => {
    const node: TreeNode = { id: "jobs", type: "database-job-admin", label: "tree.nativeJobs" };
    expect(sidebarTreeDisplayLabel(node, (key) => `translated:${key}`)).toBe("translated:tree.nativeJobs");
  });
});
