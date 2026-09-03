import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../TableStructureEditor.vue", import.meta.url), "utf8");

describe("TableStructureEditor DDL search wiring", () => {
  it("uses a CodeMirror editor and the shared search panel", () => {
    expect(source).toContain('import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";');
    expect(source).toContain('key: "Mod-f"');
    expect(source).toContain('else if (activeTab.value === "ddl") ddlSearchPanelRef.value?.openSearch();');
    expect(source).not.toContain("ddlPreRef");
    expect(source).not.toContain("onDdlKeydown");
  });

  it("keeps the DDL editable only where an executable script makes sense", () => {
    // Editable for an existing table with loaded DDL; the create-table flow has
    // no DDL tab and an empty baseline only renders a placeholder string, which
    // must never become editable (and so never executable) text.
    expect(source).toContain("EditorState.readOnly.of(!ddlEditingEnabled.value)");
    expect(source).toMatch(/const ddlEditingEnabled = computed\(\(\) => !isCreateMode\.value && .*ddlContent\.value\.trim\(\)\)/);
    expect(source).not.toContain("EditorState.readOnly.of(true)");
  });

  it("records user edits into ddlDraft without echoing its own document writes", () => {
    expect(source).toContain("if (!update.docChanged || applyingDdlDocument || !ddlEditingEnabled.value) return;");
    expect(source).toContain("ddlDraft.value = update.state.doc.toString();");
    expect(source).toContain("applyingDdlDocument = true;");
  });

  it("initializes the editor from the container ref so a delayed tab mount still renders", () => {
    // Regression guard for the blank DDL tab: reka-ui's TabsContent mounts its
    // slot one tick after the tab becomes active, so a lone nextTick guess runs
    // while ddlEditorContainer is still undefined.
    expect(source).toMatch(/watch\(\s*ddlEditorContainer,/);
    expect(source).toContain('if (activeTab.value !== "ddl" || loading.value || ddlLoading.value) return;');
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
