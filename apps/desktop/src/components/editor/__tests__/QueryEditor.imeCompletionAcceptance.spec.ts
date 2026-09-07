import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editorSource = readFileSync(new URL("../QueryEditor.vue", import.meta.url), "utf8");

function functionSource(name: string, nextName: string) {
  const start = editorSource.indexOf(`function ${name}(`);
  const end = editorSource.indexOf(`function ${nextName}(`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return editorSource.slice(start, end);
}

// Regression test for #8029: while an IME composition is active, Enter and the
// completion-accept shortcut belong to the IME candidate list. The acceptance
// handlers gate on the same isEditorComposing helper the completion providers
// already use, and the delayed retries must drop their queued acceptance once
// a composition starts instead of accepting over (or after) it.
describe("QueryEditor IME-safe completion acceptance", () => {
  it("gates the Enter handler on IME composition before any acceptance", () => {
    const source = functionSource("handleEnter", "clearPendingCompletionEnter");
    const composingGuard = source.indexOf("if (isEditorComposing(view)) return false;");
    const acceptCall = source.indexOf("codeMirrorAcceptCompletion?.(view)");

    expect(composingGuard).toBeGreaterThanOrEqual(0);
    expect(acceptCall).toBeGreaterThan(composingGuard);
  });

  it("gates the Tab completion-accept handler on IME composition", () => {
    const source = functionSource("acceptCompletionOrNextSnippetField", "clearPendingCompletionTab");
    const composingGuard = source.indexOf("if (isEditorComposing(view)) return false;");
    const selectionCheck = source.indexOf("view.state.selection.ranges.every");

    expect(composingGuard).toBeGreaterThanOrEqual(0);
    expect(selectionCheck).toBeGreaterThan(composingGuard);
  });

  it("drops the pending Tab acceptance retry when an IME composition starts", () => {
    const source = functionSource("waitForCompletionTab", "wordWrapExtension");
    const retry = source.indexOf("const retry = () => {");
    const composingGuard = source.indexOf("if (isEditorComposing(view)) return;", retry);

    expect(retry).toBeGreaterThanOrEqual(0);
    expect(composingGuard).toBeGreaterThan(retry);
  });

  it("passes an IME guard to the Enter acceptance retry helper", () => {
    const source = functionSource("handleEnter", "clearPendingCompletionEnter");
    expect(source.includes("isComposing: () => isEditorComposing(view)")).toBe(true);
  });
});
