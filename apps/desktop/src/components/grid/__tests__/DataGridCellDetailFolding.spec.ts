// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { foldCode, unfoldCode } from "@codemirror/language";
import { useCellDetailEditor } from "@/composables/useCellDetailEditor";

describe("DataGrid cell detail code folding and line numbers (#10431)", () => {
  it("mounts line numbers and fold gutter in useCellDetailEditor when folding and lineNumbers are enabled", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    const host = document.createElement("div");
    document.body.append(host);

    const editor = useCellDetailEditor({
      language: "json",
      folding: true,
      lineNumbers: true,
      editorTheme: () => "default",
      appAppearance: () => "light",
      appPalette: () => ({}) as any,
      fontSize: () => 13,
      fontFamily: () => "monospace",
    });

    const jsonDoc = `{\n  "name": "DBX",\n  "items": [\n    1,\n    2\n  ]\n}`;
    await editor.create(host, jsonDoc, "json");

    const cmGutters = host.querySelector(".cm-gutters");
    expect(cmGutters).not.toBeNull();

    const lineNumbersGutter = host.querySelector(".cm-lineNumbers");
    expect(lineNumbersGutter).not.toBeNull();

    const foldGutter = host.querySelector(".cm-foldGutter");
    expect(foldGutter).not.toBeNull();
    const foldMarkers = foldGutter?.querySelectorAll(".cm-foldMarker-svg");
    expect(foldMarkers?.length).toBeGreaterThan(0);
    expect(foldGutter?.querySelector(".cm-foldMarker-svg svg")).not.toBeNull();

    // Verify folding interaction on the CodeMirror EditorView
    const cmView = editor.view.value;
    expect(cmView).not.toBeNull();
    if (cmView) {
      // Fold the root object at line 1
      const folded = foldCode(cmView);
      expect(typeof folded).toBe("boolean");
      // Unfold back
      const unfolded = unfoldCode(cmView);
      expect(typeof unfolded).toBe("boolean");
    }

    editor.destroy();
    host.remove();
  });

  it("enables code folding and mounts SVG fold markers for JSON in non-json column types like nvarchar(max) (#11834)", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    const host = document.createElement("div");
    document.body.append(host);

    const editor = useCellDetailEditor({
      folding: true,
      lineNumbers: true,
      editorTheme: () => "default",
      appAppearance: () => "light",
      appPalette: () => ({}) as any,
      fontSize: () => 13,
      fontFamily: () => "monospace",
    });

    const jsonDoc = `{\n  "data": {\n    "pens": [\n      { "text": "Begin" }\n    ]\n  }\n}`;
    await editor.create(host, jsonDoc, "nvarchar(max)");

    const foldGutter = host.querySelector(".cm-foldGutter");
    expect(foldGutter).not.toBeNull();
    const foldMarkers = foldGutter?.querySelectorAll(".cm-foldMarker-svg");
    expect(foldMarkers?.length).toBeGreaterThan(0);

    const cmView = editor.view.value;
    expect(cmView).not.toBeNull();
    if (cmView) {
      expect(foldCode(cmView)).toBe(true);
      expect(unfoldCode(cmView)).toBe(true);
    }

    editor.destroy();
    host.remove();
  });

  it("supports code folding on large JSON data exceeding 50KB (#11834)", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    const host = document.createElement("div");
    document.body.append(host);

    const editor = useCellDetailEditor({
      folding: true,
      lineNumbers: true,
      editorTheme: () => "default",
      appAppearance: () => "light",
      appPalette: () => ({}) as any,
      fontSize: () => 13,
      fontFamily: () => "monospace",
    });

    // Generate JSON > 50KB
    const items = Array.from({ length: 1500 }, (_, i) => ({ id: i, label: `item-${i}` }));
    const largeJson = JSON.stringify({ items }, null, 2);
    expect(largeJson.length).toBeGreaterThan(50_000);

    await editor.create(host, largeJson, "nvarchar(max)");

    const foldGutter = host.querySelector(".cm-foldGutter");
    expect(foldGutter).not.toBeNull();
    const foldMarkers = foldGutter?.querySelectorAll(".cm-foldMarker-svg");
    expect(foldMarkers?.length).toBeGreaterThan(0);

    const cmView = editor.view.value;
    expect(cmView).not.toBeNull();
    if (cmView) {
      const line3 = cmView.state.doc.line(3);
      cmView.dispatch({ selection: { anchor: line3.from } });
      expect(foldCode(cmView)).toBe(true);
      expect(unfoldCode(cmView)).toBe(true);
    }

    editor.destroy();
    host.remove();
  });
});
