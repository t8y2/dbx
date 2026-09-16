// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { beginTableReferenceDragFeedback, isOverSqlEditorTarget, isPointOverElementRoot } from "@/lib/editor/tableReferenceDragFeedback";

afterEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
  document.body.style.cursor = "";
});

describe("isOverSqlEditorTarget", () => {
  it("detects pointers inside the query editor root only", () => {
    const editor = document.createElement("div");
    editor.setAttribute("data-query-editor-root", "");
    const inner = document.createElement("textarea");
    editor.appendChild(inner);
    document.body.appendChild(editor);

    document.elementFromPoint = () => inner;
    expect(isOverSqlEditorTarget(10, 10)).toBe(true);
    document.elementFromPoint = () => document.body;
    expect(isOverSqlEditorTarget(10, 10)).toBe(false);
  });

  it("falls back to geometric bounds when elementFromPoint hits an overlay", () => {
    const editor = document.createElement("div");
    editor.setAttribute("data-query-editor-root", "");
    Object.defineProperty(editor, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 400, bottom: 300 }),
    });
    document.body.appendChild(editor);

    // 命中被透明覆盖层拦截时，回退为编辑器包围盒判定。
    document.elementFromPoint = () => null;
    expect(isOverSqlEditorTarget(10, 10)).toBe(true);
    // 覆盖层命中但不落在任何编辑器包围盒内仍为 false。
    const farEditor = document.createElement("div");
    farEditor.setAttribute("data-query-editor-root", "");
    Object.defineProperty(farEditor, "getBoundingClientRect", {
      value: () => ({ left: 500, top: 500, right: 900, bottom: 800 }),
    });
    document.body.appendChild(farEditor);
    document.elementFromPoint = () => null;
    expect(isOverSqlEditorTarget(450, 450)).toBe(false);
    expect(isOverSqlEditorTarget(600, 600)).toBe(true);
  });
});

describe("isPointOverElementRoot", () => {
  it("requires elementFromPoint to hit inside the given root", () => {
    const editor = document.createElement("div");
    const inner = document.createElement("textarea");
    editor.appendChild(inner);
    document.body.appendChild(editor);

    document.elementFromPoint = () => inner;
    expect(isPointOverElementRoot(10, 10, editor)).toBe(true);
    document.elementFromPoint = () => document.body;
    expect(isPointOverElementRoot(10, 10, editor)).toBe(false);
    expect(isPointOverElementRoot(10, 10, null)).toBe(false);
  });

  it("falls back to the root bounding box when elementFromPoint hits an overlay", () => {
    const editor = document.createElement("div");
    Object.defineProperty(editor, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 400, bottom: 300 }),
    });
    document.body.appendChild(editor);

    // 覆盖层拦截时回退为传入根节点的包围盒判定。
    const overlay = document.createElement("div");
    document.elementFromPoint = () => overlay;
    expect(isPointOverElementRoot(10, 10, editor)).toBe(true);
    expect(isPointOverElementRoot(450, 450, editor)).toBe(false);
  });
});

describe("beginTableReferenceDragFeedback", () => {
  it("shows a following chip and restores body state on end", () => {
    const feedback = beginTableReferenceDragFeedback("id, name 等 3 列");
    const chip = document.querySelector<HTMLElement>("[data-table-reference-drag-chip]");
    expect(chip?.textContent).toBe("id, name 等 3 列");
    expect(document.body.style.cursor).toBe("copy");
    expect(chip?.style.visibility).toBe("hidden");

    feedback.update(40, 60);
    expect(chip?.style.visibility).toBe("visible");
    expect(Number.parseFloat(chip!.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(chip!.style.top)).toBeGreaterThanOrEqual(8);

    feedback.end();
    expect(document.querySelector("[data-table-reference-drag-chip]")).toBeNull();
    expect(document.body.style.cursor).toBe("");
  });

  it("clamps the chip inside the viewport", () => {
    const feedback = beginTableReferenceDragFeedback("col");
    const chip = document.querySelector<HTMLElement>("[data-table-reference-drag-chip]")!;
    feedback.update(window.innerWidth - 2, window.innerHeight - 2);
    const left = Number.parseFloat(chip.style.left);
    const top = Number.parseFloat(chip.style.top);
    expect(left + chip.getBoundingClientRect().width).toBeLessThanOrEqual(window.innerWidth);
    expect(top + chip.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight);
    feedback.end();
  });
});
