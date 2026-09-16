import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const connectionTreeSource = readFileSync(new URL("../ConnectionTree.vue", import.meta.url), "utf8");

describe("ConnectionTree selection pruning", () => {
  it("does not track the visible tree outside multi-selection", () => {
    expect(connectionTreeSource).toContain("store.connectionMultiSelectActive || store.selectedTreeNodeIds.length > 1");
    expect(connectionTreeSource).toContain("hasTreeMultiSelection.value ? flatTreeIndex.value.nodeById : null");
    expect(connectionTreeSource).not.toMatch(/watch\(\s*visibleNodes,/);
  });

  it("defers selection cleanup until after the tree render", () => {
    expect(connectionTreeSource).toMatch(/pruneTreeSelectionToVisibleNodeIds[\s\S]*?\{ flush: "post" \}/);
  });
});
