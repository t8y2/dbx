import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../EditorGroupTabBar.vue", import.meta.url), "utf8");
const tabMenuSource = readFileSync(new URL("../../../lib/tabs/tabMenu.ts", import.meta.url), "utf8");

describe("EditorGroupTabBar compatibility with AppTabBar", () => {
  it("keeps data-tab double-click Zen mode behavior", () => {
    expect(source).toContain('"toggle-zen-mode": []');
    expect(source).toContain('tab.mode === "data"');
    expect(source).toContain('emit("toggle-zen-mode")');
    expect(source).toContain("if (tab.id !== props.activeTabId) {");
    expect(source).toContain("startRenameTab(tab);");
  });

  it("only offers Duplicate for query tabs", () => {
    expect(tabMenuSource).toContain("visible: options.canRename");
    expect(source).toContain("createRenameDuplicateTabItems");
  });

  it("does not double-activate from the tab item click", () => {
    expect(source).toContain("function activateTab(tabId: string) {");
    expect(source).toContain('emit("activate-tab", tabId);');
    expect(source).not.toContain("queryStore.activateTabInGroup(props.groupId, tabId);");
  });

  it("cleans up drag listeners on cancel, blur, and unmount", () => {
    expect(source).toContain("function cleanupTabDrag(event?: Event)");
    expect(source).toContain('window.addEventListener("pointercancel", cleanupTabDrag)');
    expect(source).toContain('window.addEventListener("blur", cleanupTabDrag)');
    expect(source).toContain("onUnmounted(cleanupTabDrag)");
  });

  it("validates drag source and target groups before moving", () => {
    expect(source).toContain("serializeTabDragPayload");
    expect(source).toContain("parseTabDragPayload");
    expect(source).toContain("const sourceGroupExists = queryStore.groups.some((group) => group.id === payload.sourceGroupId)");
    expect(source).toContain("const targetGroupExists = queryStore.groups.some((group) => group.id === targetGroupId)");
    expect(source).toContain("if (!sourceGroupExists || !targetGroupExists) {");
  });
});
