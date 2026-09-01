import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../TableStructureEditor.vue", import.meta.url), "utf8");

describe("TableStructureEditor DDL search wiring", () => {
  it("uses a read-only CodeMirror viewer and the shared search panel", () => {
    expect(source).toContain('import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";');
    expect(source).toContain('key: "Mod-f"');
    expect(source).toContain('else if (activeTab.value === "ddl") ddlSearchPanelRef.value?.openSearch();');
    expect(source).toContain("EditorState.readOnly.of(true)");
    expect(source).not.toContain("ddlPreRef");
    expect(source).not.toContain("onDdlKeydown");
  });

  it("refreshes and disposes the DDL editor across its component lifecycle", () => {
    expect(source).toContain("if (force) destroyDdlEditor();");
    expect(source).toContain("observeDdlEditorScroll(editorView);");
    expect(source).toContain("ddlEditorView.value.scrollDOM.scrollTop");
    expect(source).toContain('if (activeTab.value !== "ddl") destroyDdlEditor();');
    expect(source).toContain("onDeactivated(() => {");
    expect(source).toContain("onBeforeUnmount(() => {");
    expect(source.match(/destroyDdlEditor\(\);/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
