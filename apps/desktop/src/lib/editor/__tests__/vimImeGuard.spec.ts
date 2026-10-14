// @vitest-environment happy-dom

import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { getCM, vim } from "@replit/codemirror-vim";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVimImeGuard } from "../vimImeGuard";

const views: EditorView[] = [];
const sample = "SELECT 1;\nSELECT 2;\nSELECT 3;";

function editor(enabled = true) {
  const compartment = new Compartment();
  const extension = () => [vim({ status: true }), createVimImeGuard({ EditorView, ViewPlugin }, getCM)];
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: sample, extensions: [history(), compartment.of(enabled ? Prec.highest(extension()) : [])] }),
  });
  views.push(view);
  return { view, disable: () => view.dispatch({ effects: compartment.reconfigure([]) }), enable: () => view.dispatch({ effects: compartment.reconfigure(Prec.highest(extension())) }) };
}

function key(view: EditorView, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function input(view: EditorView, text: string) {
  const from = view.state.selection.main.from;
  const to = view.state.selection.main.to;
  for (const handler of view.state.facet(EditorView.inputHandler)) {
    if (handler(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text }, userEvent: "input.type.compose" }))) return true;
  }
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type.compose" });
  return false;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

describe("Vim IME command guard", () => {
  it.each([
    { key: "l", code: "KeyL", isComposing: true },
    { key: "Process", code: "KeyL", keyCode: 229 },
    { key: "Unidentified", code: "KeyL", keyCode: 229 },
    { key: "Unidentified", code: "KeyL" },
    { key: "l", code: "KeyL", keyCode: 229 },
  ])("moves the cursor without inserting text for $key / $keyCode / $isComposing", (event) => {
    const { view } = editor();
    expect(key(view, event.key, event).defaultPrevented).toBe(true);
    expect(view.state.selection.main.head).toBe(1);
    expect(view.state.doc.toString()).toBe(sample);
  });

  it("handles keys ignored by CodeMirror while a composition is active", () => {
    const { view } = editor();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    key(view, "l", { code: "KeyL", isComposing: true });
    key(view, "l", { code: "KeyL", isComposing: true });
    expect(view.state.selection.main.head).toBe(2);
    expect(view.state.doc.toString()).toBe(sample);
  });

  it("preserves counted commands, operators and undo", () => {
    const { view } = editor();
    for (const code of ["Digit2", "KeyD", "KeyD"]) key(view, "Process", { code, keyCode: 229 });
    expect(view.state.doc.toString()).toBe("SELECT 3;");
    key(view, "u", { isComposing: true });
    expect(view.state.doc.toString()).toBe(sample);
  });

  it.each(["hjkl", "你好", "中", "z"])("rejects stray normal-mode text %s", (text) => {
    const { view } = editor();
    expect(input(view, text)).toBe(true);
    expect(view.state.doc.toString()).toBe(sample);
  });

  it("repairs native composition DOM changes without inserting them into a normal-mode document", async () => {
    const { view } = editor();
    view.focus();
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.contentDOM.querySelector(".cm-line")!.textContent = "hjklSELECT 1;";
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "hjkl" }));
    await vi.waitFor(() => expect(view.contentDOM.querySelector(".cm-line")!.textContent).toBe("SELECT 1;"));
    expect(view.state.doc.toString()).toBe(sample);
  });

  it("keeps native Chinese composition DOM changes in insert mode", async () => {
    const { view } = editor();
    view.focus();
    key(view, "i");
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    view.contentDOM.querySelector(".cm-line")!.textContent = "你好SELECT 1;";
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("你好" + sample));
    expect(getCM(view)?.state.vim?.insertMode).toBe(true);
  });

  it("enters insert mode via an IME key and allows Chinese composition", () => {
    const { view } = editor();
    expect(key(view, "Process", { code: "KeyI", keyCode: 229 }).defaultPrevented).toBe(true);
    expect(getCM(view)?.state.vim?.insertMode).toBe(true);
    expect(input(view, "你好")).toBe(false);
    expect(view.state.doc.toString()).toBe("你好" + sample);
    key(view, "Escape");
    expect(getCM(view)?.state.vim?.insertMode).toBe(false);
    expect(input(view, "hjkl")).toBe(true);
  });

  it("preserves shifted physical commands and visual editing", () => {
    const { view } = editor();
    key(view, "Process", { code: "KeyV", keyCode: 229, shiftKey: true });
    expect(getCM(view)?.state.vim?.visualLine).toBe(true);
    key(view, "Process", { code: "KeyD", keyCode: 229 });
    expect(view.state.doc.toString()).toBe("SELECT 2;\nSELECT 3;");
  });

  it("keeps literal-character commands working", () => {
    const { view } = editor();
    key(view, "r");
    expect(getCM(view)?.state.vim?.expectLiteralNext).toBe(true);
    key(view, "Process", { code: "KeyX", keyCode: 229 });
    expect(input(view, "x")).toBe(true);
    expect(view.state.doc.toString()).toBe("xELECT 1;\nSELECT 2;\nSELECT 3;");
  });

  it("does not consume system shortcuts, dead keys or insert-mode keydowns", () => {
    const { view } = editor();
    expect(key(view, "Process", { code: "KeyJ", keyCode: 229, metaKey: true }).defaultPrevented).toBe(false);
    expect(key(view, "Process", { code: "KeyJ", keyCode: 229, altKey: true }).defaultPrevented).toBe(false);
    expect(key(view, "Dead", { code: "Quote", isComposing: true }).defaultPrevented).toBe(false);
    expect(key(view, "F2", { isComposing: true }).defaultPrevented).toBe(false);
    key(view, "i");
    expect(key(view, "Process", { code: "KeyJ", keyCode: 229 }).defaultPrevented).toBe(false);
  });

  it("does not block clipboard or programmatic changes in normal mode", () => {
    const { view } = editor();
    view.dispatch({ changes: { from: 0, insert: "-- pasted\n" }, userEvent: "input.paste" });
    expect(view.state.doc.toString()).toBe("-- pasted\n" + sample);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(sample);
  });

  it("removes the capture listener when Vim is disabled and can be enabled again", () => {
    const { view, disable, enable } = editor();
    disable();
    expect(key(view, "Process", { code: "KeyJ", keyCode: 229 }).defaultPrevented).toBe(false);
    enable();
    key(view, "Process", { code: "KeyL", keyCode: 229 });
    expect(view.state.selection.main.head).toBe(1);
  });

  it("leaves regular typing intact when Vim is disabled", () => {
    const { view } = editor(false);
    expect(input(view, "你好")).toBe(false);
    expect(view.state.doc.toString()).toBe("你好" + sample);
  });
});
