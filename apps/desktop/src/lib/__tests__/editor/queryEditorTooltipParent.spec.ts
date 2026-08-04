import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const globalStylesSource = readFileSync(new URL("../../../styles/globals.css", import.meta.url), "utf8");

describe("QueryEditor tooltip container", () => {
  it("portals CodeMirror tooltips to a zero-sized app host", () => {
    expect(queryEditorSource).toContain("const editorElement = editorRef.value;");
    expect(queryEditorSource).toContain("if (!editorElement) return;");
    expect(queryEditorSource).toContain('querySelector<HTMLElement>("#dbx-query-editor-tooltip-root") ?? editorElement');
    expect(queryEditorSource).toContain("tooltips({ parent: tooltipParent })");
    expect(queryEditorSource).toContain("new EditorView({ state, parent: editorElement })");
    expect(queryEditorSource).not.toContain("tooltips({ parent: document.body })");
    expect(appSource).toContain('id="dbx-query-editor-tooltip-root"');
    expect(appSource).toContain('class="fixed left-0 top-0 z-[70] h-0 w-0 overflow-visible"');
  });

  it("keeps the app root viewport-sized without a transformed containing block", () => {
    const rootRule = globalStylesSource.match(/html,\s*body,\s*#root\s*\{(?<declarations>[^}]*)\}/)?.groups?.declarations;

    expect(rootRule).toBeDefined();
    expect(rootRule).toMatch(/width:\s*100%/);
    expect(rootRule).toMatch(/height:\s*100%/);
    expect(rootRule).toMatch(/overflow:\s*hidden/);
    expect(rootRule).not.toMatch(/(?:^|\s)(?:transform|contain)\s*:/);
  });
});
