import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const connectionTreeSource = readFileSync(new URL("../ConnectionTree.vue", import.meta.url), "utf8");

describe("ConnectionTree locate in collapsed groups", () => {
  it("reopens collapsed connection groups on the node path through the persisted layout op", () => {
    // Group expansion must flow through store.expandConnectionGroups so
    // layout.collapsed is flipped and the next layout rebuild keeps the group
    // open; flipping isExpanded directly would be reverted by that rebuild.
    expect(connectionTreeSource).toMatch(/const collapsedGroupIds = nodePath\s*\.filter\(\(node\) => node\.type === "connection-group" && !node\.isExpanded\)\s*\.map\(\(node\) => node\.id\);/);
    // The expansion happens before the flat-tree match that drives selection,
    // scrolling and flashing, so the reopened groups are visible to it.
    expect(connectionTreeSource).toMatch(/store\.expandConnectionGroups\(collapsedGroupIds\);\s*\}\s*\n\s*await nextTick\(\);\s*\n\s*const match = target \? findSidebarNodeForTarget\(target, flatNodes\.value\) : null;/);
  });

  it("still gates generic ancestor expansion on loaded children only (#5850)", () => {
    expect(connectionTreeSource).toMatch(/if \(!ancestor\.isExpanded && store\.canUseLoadedTreeNodeToggle\(ancestor\)\) \{\s*ancestor\.isExpanded = true;\s*\}/);
  });
});
