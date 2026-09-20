import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../QueryEditor.vue", import.meta.url), "utf8");

describe("QueryEditor goto-line wiring", () => {
  it("binds the platform goto-line shortcut next to find, before formatSql", () => {
    const gotoLineIndex = queryEditorSource.indexOf("...binding(shortcuts.gotoLine, openGotoLine),");
    const findIndex = queryEditorSource.indexOf("...binding(shortcuts.find, openSearch),");
    const formatIndex = queryEditorSource.indexOf("...binding(shortcuts.formatSql,");

    expect(findIndex).toBeGreaterThan(-1);
    expect(gotoLineIndex).toBeGreaterThan(findIndex);
    // 非 mac 上 Ctrl+G 同时是 CodeMirror 内置的 find-next，运行时的 Prec.high
    // keymap 先匹配先执行，因此跳转绑定必须注册在搜索键位之前。
    expect(formatIndex).toBeGreaterThan(gotoLineIndex);
  });

  it("routes the panel toggles through the exposed handles", () => {
    expect(queryEditorSource).toContain("function openGotoLine(): boolean {\n  return gotoLinePanelRef.value?.openGotoLine() ?? false;\n}");
    expect(queryEditorSource).toContain('<EditorGotoLinePanel ref="gotoLinePanelRef" :view="view" @open="searchPanelRef?.closeSearch()" />');
    expect(queryEditorSource).toContain('<EditorSearchPanel ref="searchPanelRef" :view="view" @open="gotoLinePanelRef?.closeGotoLine()" />');
  });
});
