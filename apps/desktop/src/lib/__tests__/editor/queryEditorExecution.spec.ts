import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createQueryEditorExecutionViewportOwnership, isQueryEditorPositionVisible } from "../../editor/queryEditorExecutionViewport";

const queryEditorSource = ["QueryEditor.vue", "useQueryEditorExecution.ts"].map((file) => readFileSync(new URL(`../../../components/editor/${file}`, import.meta.url), "utf8")).join("\n");

describe("QueryEditor execution routing", () => {
  it("routes the execution shortcut through the shared execution-mode contract while bypassing the picker", () => {
    expect(queryEditorSource).toContain("createQueryEditorExecutionShortcutBindings(shortcuts.executeSql");
    expect(queryEditorSource).not.toContain("forceCurrent");
  });
});

describe("QueryEditor execution viewport ownership", () => {
  it("leaves completion positioning unclaimed when the user does not interact during execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();

    ownership.beginExecution();

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
