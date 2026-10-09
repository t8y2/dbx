// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createQueryEditorExecutionViewportOwnership, isQueryEditorPositionVisible, locateCursorForGutterExecution } from "../../editor/queryEditorExecutionViewport";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const queryEditorSource = ["QueryEditor.vue", "useQueryEditorExecution.ts"].map((file) => readFileSync(path.resolve(specDir, "../../../components/editor", file), "utf8")).join("\n");

describe("QueryEditor execution routing", () => {
  it("routes the execution shortcut through the shared execution-mode contract while bypassing the picker", () => {
    expect(queryEditorSource).toContain("createQueryEditorExecutionShortcutBindings(shortcuts.executeSql");
    expect(queryEditorSource).not.toContain("forceCurrent");
  });

  it("snapshots pre-execution cursor visibility when execution viewport tracking starts", () => {
    expect(queryEditorSource).toContain("beginExecution(cursorVisible)");
  });
});

describe("QueryEditor gutter execution cursor positioning", () => {
  function createEditor(doc: string, selection?: { anchor: number; head?: number }): EditorView {
    return new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc,
        selection: selection ? EditorSelection.single(selection.anchor, selection.head ?? selection.anchor) : undefined,
      }),
    });
  }

  it("positions cursor at statement start and focuses editor on gutter execution when enabled", () => {
    const doc = "select * from users;\nselect * from orders;";
    const statementRange = { from: 21, to: 42 };
    const view = createEditor(doc, { anchor: 0 });
    const focusSpy = vi.spyOn(view, "focus");

    const result = locateCursorForGutterExecution(view, statementRange, true);

    expect(result.selectionOverlapsStatement).toBe(false);
    expect(result.cursorRelocated).toBe(true);
    expect(view.state.selection.main.from).toBe(statementRange.from);
    expect(view.state.selection.main.to).toBe(statementRange.from);
    expect(view.state.selection.main.empty).toBe(true);
    expect(focusSpy).toHaveBeenCalledOnce();
    view.destroy();
  });

  it("preserves active overlapping selection within statement while focusing editor", () => {
    const doc = "select * from users;\nselect * from orders;";
    const statementRange = { from: 21, to: 42 };
    const view = createEditor(doc, { anchor: 35, head: 41 });
    const focusSpy = vi.spyOn(view, "focus");

    const result = locateCursorForGutterExecution(view, statementRange, true);

    expect(result.selectionOverlapsStatement).toBe(true);
    expect(result.cursorRelocated).toBe(false);
    expect(view.state.selection.main.anchor).toBe(35);
    expect(view.state.selection.main.head).toBe(41);
    expect(focusSpy).toHaveBeenCalledOnce();
    view.destroy();
  });

  it("relocates cursor when active selection is elsewhere in the document and does not overlap statement", () => {
    const doc = "select * from users;\nselect * from orders;";
    const statementRange = { from: 21, to: 42 };
    const view = createEditor(doc, { anchor: 14, head: 19 });
    const focusSpy = vi.spyOn(view, "focus");

    const result = locateCursorForGutterExecution(view, statementRange, true);

    expect(result.selectionOverlapsStatement).toBe(false);
    expect(result.cursorRelocated).toBe(true);
    expect(view.state.selection.main.from).toBe(statementRange.from);
    expect(view.state.selection.main.to).toBe(statementRange.from);
    expect(view.state.selection.main.empty).toBe(true);
    expect(focusSpy).toHaveBeenCalledOnce();
    view.destroy();
  });

  it("does not alter cursor position or focus editor when disabled", () => {
    const doc = "select * from users;\nselect * from orders;";
    const statementRange = { from: 21, to: 42 };
    const view = createEditor(doc, { anchor: 5 });
    const focusSpy = vi.spyOn(view, "focus");

    const result = locateCursorForGutterExecution(view, statementRange, false);

    expect(result.selectionOverlapsStatement).toBe(false);
    expect(result.cursorRelocated).toBe(false);
    expect(view.state.selection.main.from).toBe(5);
    expect(view.state.selection.main.to).toBe(5);
    expect(focusSpy).not.toHaveBeenCalled();
    view.destroy();
  });

  it("treats whitespace-only selection within statement as non-overlapping and relocates cursor", () => {
    const doc = "select * from users;\nselect   * from orders;";
    const statementRange = { from: 21, to: 44 };
    const view = createEditor(doc, { anchor: 27, head: 30 });
    const focusSpy = vi.spyOn(view, "focus");

    const result = locateCursorForGutterExecution(view, statementRange, true);

    expect(result.selectionOverlapsStatement).toBe(false);
    expect(result.cursorRelocated).toBe(true);
    expect(view.state.selection.main.from).toBe(statementRange.from);
    expect(view.state.selection.main.to).toBe(statementRange.from);
    expect(view.state.selection.main.empty).toBe(true);
    expect(focusSpy).toHaveBeenCalledOnce();
    view.destroy();
  });
});

describe("QueryEditor execution viewport ownership", () => {
  it("leaves completion positioning unclaimed when the user does not interact during execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();

    ownership.beginExecution();

    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("preserves the viewport when the cursor was visible before execution (#10480)", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();

    // Cmd+Enter path: no gutter request, no user interaction, but the cursor
    // was comfortably visible in the pre-execution viewport. The results pane
    // then shrinks the editor — that shrink must not scroll the cursor away.
    ownership.beginExecution(true);

    expect(ownership.consumeCompletionPreservation()).toBe(true);
    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("still centers the cursor when it was off-screen before execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();

    // #5281 contract: a cursor that was already out of sight before execution
    // gets centered once the results pane has taken its space.
    ownership.beginExecution(false);

    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("preserves the viewport once after user interaction during execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();

    ownership.beginExecution();
    ownership.recordUserInteraction();

    expect(ownership.consumeCompletionPreservation()).toBe(true);
    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("ignores editor interaction outside an active execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();

    ownership.recordUserInteraction();

    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("does not let a cancelled or early-returned gutter request affect the next ordinary execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    const cancelledRequestId = ownership.beginRequest();

    expect(ownership.cancelPendingRequest(cancelledRequestId)).toBe(true);

    expect(ownership.acceptRequest(cancelledRequestId)).toBe(false);
    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("preserves the viewport once for the matching accepted execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    const requestId = ownership.beginRequest();

    expect(ownership.acceptRequest(requestId)).toBe(true);
    ownership.beginExecution();
    expect(ownership.consumeCompletionPreservation()).toBe(true);
    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("clears pending and accepted ownership when the editor becomes inactive", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    const pendingRequestId = ownership.beginRequest();
    ownership.reset();

    expect(ownership.acceptRequest(pendingRequestId)).toBe(false);

    const acceptedRequestId = ownership.beginRequest();
    expect(ownership.acceptRequest(acceptedRequestId)).toBe(true);
    ownership.reset();

    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("clears execution interaction when the editor becomes inactive", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    ownership.beginExecution();
    ownership.recordUserInteraction();

    ownership.reset();

    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });
});

describe("QueryEditor completion cursor visibility", () => {
  const viewport = { from: 10, to: 20 };

  it("treats a position inside a visible range as visible", () => {
    expect(isQueryEditorPositionVisible(15, [{ from: 10, to: 20 }], viewport)).toBe(true);
  });

  it("includes range endpoints but excludes adjacent positions", () => {
    expect(isQueryEditorPositionVisible(10, [{ from: 10, to: 20 }], viewport)).toBe(true);
    expect(isQueryEditorPositionVisible(20, [{ from: 10, to: 20 }], viewport)).toBe(true);
    expect(isQueryEditorPositionVisible(9, [{ from: 10, to: 20 }], viewport)).toBe(false);
    expect(isQueryEditorPositionVisible(21, [{ from: 10, to: 20 }], viewport)).toBe(false);
  });

  it("accepts any visible range without treating a folded gap as visible", () => {
    const visibleRanges = [
      { from: 10, to: 14 },
      { from: 17, to: 20 },
    ];

    expect(isQueryEditorPositionVisible(18, visibleRanges, viewport)).toBe(true);
    expect(isQueryEditorPositionVisible(15, visibleRanges, viewport)).toBe(false);
  });

  it("falls back to the viewport when visible ranges are unavailable or empty", () => {
    expect(isQueryEditorPositionVisible(15, undefined, viewport)).toBe(true);
    expect(isQueryEditorPositionVisible(15, [], viewport)).toBe(true);
    expect(isQueryEditorPositionVisible(21, undefined, viewport)).toBe(false);
  });
});
