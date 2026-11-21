// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchCopyActiveResultShortcut, registerCopyActiveResultShortcut } from "@/lib/editor/queryActiveResultShortcut";

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

async function mountMacEditor(options: { enabled?: boolean; binding?: string } = {}) {
  vi.stubGlobal("navigator", {
    maxTouchPoints: 0,
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    vendor: "Google Inc.",
  });
  vi.resetModules();
  const [{ EditorState }, { EditorView, keymap }, { defaultKeymap }, { sql }, { defaultKeymapForGlobalShortcuts }] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("@codemirror/commands"),
    import("@codemirror/lang-sql"),
    import("@/lib/editor/codemirrorDefaultKeymap"),
  ]);
  const context = {
    enabled: options.enabled ?? true,
    shortcuts: { copyActiveResult: options.binding ?? "Mod+I" },
    platform: "MacIntel",
    copyActiveResult: vi.fn(() => true),
  };
  const root = document.createElement("div");
  root.dataset.queryEditorRoot = "";
  document.body.append(root);
  const view = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: "SELECT id FROM users",
      selection: { anchor: 8 },
      extensions: [sql(), keymap.of(defaultKeymapForGlobalShortcuts(defaultKeymap, context.shortcuts))],
    }),
  });
  cleanups.push(() => view.destroy());
  const unregister = registerCopyActiveResultShortcut(() => context);
  cleanups.push(unregister);
  view.focus();
  return { context, view, unregister };
}

function dispatchCommandI(target: HTMLElement, options: { repeat?: boolean; isComposing?: boolean } = {}) {
  const event = new KeyboardEvent("keydown", { key: "i", code: "KeyI", metaKey: true, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

function dispatch(target: Element, options: { enabled?: boolean; accepted?: boolean; repeat?: boolean; isComposing?: boolean; prevented?: boolean; binding?: string } = {}) {
  const copyActiveResult = vi.fn(() => options.accepted ?? true);
  const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true, repeat: options.repeat, isComposing: options.isComposing });
  if (options.prevented) event.preventDefault();
  let handled = false;
  const listener = (event: KeyboardEvent) => {
    handled = dispatchCopyActiveResultShortcut(event, {
      enabled: options.enabled ?? true,
      shortcuts: { copyActiveResult: options.binding ?? "Mod+C" },
      platform: "Win32",
      copyActiveResult,
    });
  };
  window.addEventListener("keydown", listener);
  try {
    target.dispatchEvent(event);
  } finally {
    window.removeEventListener("keydown", listener);
  }
  return { event, handled, copyActiveResult };
}

function mount(markup: string): HTMLElement {
  document.body.innerHTML = markup;
  return document.querySelector<HTMLElement>("[data-target]")!;
}

describe("copy active result shortcut dispatch", () => {
  it("accepts the SQL editor without changing its focus or text selection", () => {
    const editor = mount('<div data-query-editor-root><div class="cm-content" contenteditable="true" tabindex="0" data-target>SELECT 123</div></div>');
    editor.focus();
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(editor.firstChild!, 7);
    range.setEnd(editor.firstChild!, 10);
    selection.removeAllRanges();
    selection.addRange(range);
    const result = dispatch(editor);
    expect(result.handled).toBe(true);
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.copyActiveResult).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(editor);
    expect(selection.toString()).toBe("123");
  });

  it("consumes a configured copy key even when the current query has no result", () => {
    const editor = mount('<div data-query-editor-root><div class="cm-content" contenteditable="true" data-target>SELECT secret</div></div>');
    const result = dispatch(editor, { accepted: false });
    expect(result.handled).toBe(true);
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.copyActiveResult).toHaveBeenCalledOnce();
  });

  it.each([
    '<input data-target value="connection search">',
    "<textarea data-target>notes</textarea>",
    "<select data-target><option>value</option></select>",
    '<div contenteditable="true" data-target>cell value</div>',
    '<div role="textbox" data-target>cell value</div>',
    '<div data-query-editor-root><input class="cm-search" data-target></div>',
    '<div role="dialog"><div data-query-editor-root><div class="cm-content" contenteditable="true" data-target>SELECT 1</div></div></div>',
    '<div role="alertdialog"><button data-target>Confirm</button></div>',
    "<button data-shortcut-recorder data-target>Record</button>",
    "<button data-shortcut-input data-target>Shortcut</button>",
    "<button data-sql-shortcut-input data-target>SQL shortcut</button>",
  ])("leaves editing and modal surfaces untouched: %s", (markup) => {
    const result = dispatch(mount(markup));
    expect(result.handled).toBe(false);
    expect(result.event.defaultPrevented).toBe(false);
    expect(result.copyActiveResult).not.toHaveBeenCalled();
  });

  it.each([{ enabled: false }, { binding: "" }, { isComposing: true }, { prevented: true }])("does not dispatch outside its active shortcut context: %o", (options) => {
    const result = dispatch(document.body, options);
    expect(result.handled).toBe(false);
    expect(result.copyActiveResult).not.toHaveBeenCalled();
  });

  it("consumes held-key repeats without starting another copy", () => {
    const result = dispatch(document.body, { repeat: true });
    expect(result.handled).toBe(true);
    expect(result.event.defaultPrevented).toBe(true);
    expect(result.copyActiveResult).not.toHaveBeenCalled();
  });
});

describe("copy active result registration with the real macOS editor keymap", () => {
  it("handles configured Command+I before CodeMirror can change the SQL selection", async () => {
    const { context, view } = await mountMacEditor();
    const selection = view.state.selection;
    const event = dispatchCommandI(view.contentDOM);
    expect(context.copyActiveResult).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(document.activeElement).toBe(view.contentDOM);
    expect(view.state.doc.toString()).toBe("SELECT id FROM users");
  });

  it.each([{ binding: "" }, { enabled: false }])("retains the native CodeMirror command when the copy shortcut is unavailable: %o", async (options) => {
    const { context, view } = await mountMacEditor(options);
    dispatchCommandI(view.contentDOM);
    expect(context.copyActiveResult).not.toHaveBeenCalled();
    expect(view.state.selection.main.from).toBe(7);
    expect(view.state.selection.main.to).toBe(9);
  });

  it("leaves input fields and modal editor surfaces untouched", async () => {
    const { context, view } = await mountMacEditor();
    const input = document.createElement("input");
    view.dom.append(input);
    input.focus();
    expect(dispatchCommandI(input).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    view.dom.parentElement!.before(dialog);
    dialog.append(view.dom.parentElement!);
    dispatchCommandI(view.contentDOM);
    expect(context.copyActiveResult).not.toHaveBeenCalled();
  });

  it("consumes repeats without invoking either another copy or the editor command", async () => {
    const { context, view } = await mountMacEditor();
    const selection = view.state.selection;
    dispatchCommandI(view.contentDOM);
    expect(dispatchCommandI(view.contentDOM, { repeat: true }).defaultPrevented).toBe(true);
    expect(context.copyActiveResult).toHaveBeenCalledOnce();
    expect(view.state.selection.eq(selection)).toBe(true);
  });

  it("does not dispatch during IME composition", async () => {
    const { context, view } = await mountMacEditor();
    dispatchCommandI(view.contentDOM, { isComposing: true });
    expect(context.copyActiveResult).not.toHaveBeenCalled();
  });

  it("uses the current shortcut settings and removes its capture listener during cleanup", async () => {
    const { context, view, unregister } = await mountMacEditor({ binding: "" });
    context.shortcuts.copyActiveResult = "Mod+I";
    dispatchCommandI(view.contentDOM);
    expect(context.copyActiveResult).toHaveBeenCalledOnce();
    unregister();
    dispatchCommandI(view.contentDOM);
    expect(context.copyActiveResult).toHaveBeenCalledOnce();
    expect(view.state.selection.main.from).toBe(7);
    expect(view.state.selection.main.to).toBe(9);
  });
});
