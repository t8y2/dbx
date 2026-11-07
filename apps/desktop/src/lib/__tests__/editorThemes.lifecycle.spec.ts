// @vitest-environment happy-dom

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { editorFontTheme, loadEditorTheme, shellLineCommentTheme, sqlCompletionTheme, sqlSemanticHighlightTheme } from "@/lib/editor/editorThemes";
import { DEFAULT_CUSTOM_THEME_COLORS } from "@/stores/settingsStore";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.textContent = "";
});

function stylesheetBytes() {
  return [...document.head.querySelectorAll("style")].reduce((sum, style) => sum + (style.textContent?.length ?? 0), 0);
}

async function editorAppearance() {
  return [await loadEditorTheme("app", "light", undefined, "cursor"), editorFontTheme(EditorView, 13, "monospace", { fixedHeight: true, scrollable: true }), sqlCompletionTheme(EditorView), sqlSemanticHighlightTheme(EditorView), shellLineCommentTheme(EditorView)];
}

function mountEditor(extensions: Extension) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ state: EditorState.create({ doc: "SELECT id FROM orders;", extensions }), parent });
  views.push(view);
  return view;
}

describe("editor theme lifecycle", () => {
  it("keeps page styles stable when cached tabs restore the same appearance", async () => {
    const appearance = new Compartment();
    const view = mountEditor(appearance.of(await editorAppearance()));
    const initialBytes = stylesheetBytes();
    for (let index = 0; index < 30; index += 1) view.dispatch({ effects: appearance.reconfigure(await editorAppearance()) });
    expect(stylesheetBytes() - initialBytes, "identical tab appearances must not accumulate document-owned CSS").toBe(0);
  });

  it("does not retain another copy of the same styles after editor recreation", async () => {
    const first = mountEditor(await editorAppearance());
    first.destroy();
    views.pop();
    const initialBytes = stylesheetBytes();
    for (let index = 0; index < 30; index += 1) {
      const view = mountEditor(await editorAppearance());
      view.destroy();
      views.pop();
    }
    expect(stylesheetBytes() - initialBytes, "closed editors must not leave duplicate appearance styles").toBe(0);
  });

  it("applies edited custom colors and reuses a previous palette when restored", async () => {
    const colors = { ...DEFAULT_CUSTOM_THEME_COLORS, background: "#112233" };
    const appearance = new Compartment();
    const view = mountEditor(appearance.of(await loadEditorTheme("custom", "dark", colors)));
    const initialClasses = view.themeClasses;
    colors.background = "#445566";
    view.dispatch({ effects: appearance.reconfigure(await loadEditorTheme("custom", "dark", colors)) });
    expect(view.themeClasses).not.toBe(initialClasses);
    const changedBytes = stylesheetBytes();
    const restoredColors = Object.fromEntries(Object.entries({ ...colors, background: "#112233" }).reverse());
    view.dispatch({ effects: appearance.reconfigure(await loadEditorTheme("custom", "dark", restoredColors)) });
    expect(view.themeClasses).toBe(initialClasses);
    expect(stylesheetBytes()).toBe(changedBytes);
  });

  it("preserves font and layout changes while reusing previous font settings", () => {
    const font = new Compartment();
    const view = mountEditor(font.of(editorFontTheme(EditorView, 13, "monospace", { fixedHeight: true, scrollable: true })));
    const initialClasses = view.themeClasses;
    view.dispatch({ effects: font.reconfigure(editorFontTheme(EditorView, 18, "serif", { fixedHeight: false, scrollable: false })) });
    expect(view.themeClasses).not.toBe(initialClasses);
    const changedBytes = stylesheetBytes();
    view.dispatch({ effects: font.reconfigure(editorFontTheme(EditorView, 13, "monospace", { fixedHeight: true, scrollable: true })) });
    expect(view.themeClasses).toBe(initialClasses);
    expect(stylesheetBytes()).toBe(changedBytes);
  });
});
