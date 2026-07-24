import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createQueryEditorSearchKeymap } from "@/lib/editor/queryEditorSearchKeymap";

const editorSearchPanelSource = readFileSync(new URL("../EditorSearchPanel.vue", import.meta.url), "utf8");
const queryEditorSource = readFileSync(new URL("../QueryEditor.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../layout/ContentArea.vue", import.meta.url), "utf8");

describe("EditorSearchPanel corner style", () => {
  it("uses the configurable five-pixel radius token for editor inputs", () => {
    expect(editorSearchPanelSource).toContain("border-radius: var(--dbx-radius-fixed-5);");
  });
});

describe("QueryEditor search shortcuts", () => {
  it("opens search and replace in editable editors", () => {
    const openSearch = vi.fn(() => true);
    const openReplace = vi.fn(() => true);
    const bindings = createQueryEditorSearchKeymap({ openSearch, openReplace, isReadOnly: () => false });

    expect(bindings.map(({ key, preventDefault }) => ({ key, preventDefault }))).toEqual([
      { key: "Mod-f", preventDefault: true },
      { key: "Mod-h", preventDefault: true },
    ]);
    expect(bindings[0]?.run?.({} as never)).toBe(true);
    expect(bindings[1]?.run?.({} as never)).toBe(true);
    expect(openSearch).toHaveBeenCalledOnce();
    expect(openReplace).toHaveBeenCalledOnce();
  });

  it("allows search but consumes replace without opening it in read-only editors", () => {
    const openSearch = vi.fn(() => true);
    const openReplace = vi.fn(() => true);
    const bindings = createQueryEditorSearchKeymap({ openSearch, openReplace, isReadOnly: () => true });

    expect(bindings[0]?.run?.({} as never)).toBe(true);
    expect(bindings[1]?.run?.({} as never)).toBe(true);
    expect(openSearch).toHaveBeenCalledOnce();
    expect(openReplace).not.toHaveBeenCalled();
  });

  it("keeps the existing search navigation and read-only replace guards", () => {
    expect(queryEditorSource).toMatch(/Prec\.highest\(\s*keymap\.of\(\[\s*\.\.\.createQueryEditorSearchKeymap/);
    expect(queryEditorSource).toMatch(/function openReplace\(\): boolean \{\s*if \(props\.readOnly\) return false;/);
    expect(contentAreaSource).toContain('if (props.activeTab.mode === "query") return queryEditorRef.value?.openSearch() ?? false;');
    expect(contentAreaSource).toContain("return queryEditorRef.value?.openReplace() ?? false;");
    expect(queryEditorSource).toMatch(/key:\s*"Escape"/);
    expect(editorSearchPanelSource).toContain('e.key === "Enter" && !e.shiftKey');
    expect(editorSearchPanelSource).toContain('e.key === "Enter" && e.shiftKey');
  });
});
