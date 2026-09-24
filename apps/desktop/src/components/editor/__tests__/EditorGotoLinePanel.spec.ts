// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import EditorGotoLinePanel from "@/components/editor/EditorGotoLinePanel.vue";

interface PanelHandle {
  openGotoLine: () => boolean;
  closeGotoLine: () => boolean;
}

interface MountedPanel {
  view: EditorView;
  handle: () => PanelHandle;
  onOpen: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  panel: () => HTMLElement | null;
  input: () => HTMLInputElement;
  errorText: () => string;
}

const mounted: Array<{ app: App; host: HTMLElement; view?: EditorView }> = [];

function mountPanel(docLines = 20): MountedPanel {
  let instance: PanelHandle | null = null;
  const onOpen = vi.fn();
  const onClose = vi.fn();
  // The editor has to be attached to the document: CodeMirror's focus() is a no-op
  // on detached content (mirrors what QueryEditor.vue always renders).
  const editorHost = document.createElement("div");
  document.body.append(editorHost);
  const view = new EditorView({
    parent: editorHost,
    state: EditorState.create({ doc: Array.from({ length: docLines }, (_, index) => `line ${index + 1}`).join("\n") }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(EditorGotoLinePanel, {
            view,
            onOpen,
            onClose,
            ref: (el) => {
              if (el) instance = el as unknown as PanelHandle;
            },
          });
      },
    }),
  );
  app.mount(host);
  mounted.push({ app, host, view });
  return {
    view,
    handle: () => {
      if (!instance) throw new Error("panel not mounted");
      return instance;
    },
    onOpen,
    onClose,
    panel: () => host.querySelector<HTMLElement>(".editor-goto-line-panel"),
    input: () => {
      const input = host.querySelector<HTMLInputElement>("input");
      if (!input) throw new Error("goto-line input not rendered");
      return input;
    },
    errorText: () => host.querySelector('[aria-live="polite"]')?.textContent?.trim() ?? "",
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Vue's <Transition> keeps the leaving node in the DOM until the leave hook settles. */
async function settleLeave(panel: () => HTMLElement | null, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (panel() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await nextTick();
  }
}

function pressKey(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const { app, host, view } of mounted.splice(0)) {
    app.unmount();
    host.remove();
    view?.dom.parentElement?.remove();
    view?.destroy();
  }
});

describe("EditorGotoLinePanel", () => {
  it("stays closed until opened and prefills the caret line", async () => {
    const { view, handle, onOpen, panel, input } = mountPanel(20);
    view.dispatch({ selection: { anchor: view.state.doc.line(5).from + 3 } });

    expect(panel()).toBeNull();

    expect(handle().openGotoLine()).toBe(true);
    await nextTick();

    expect(panel()).not.toBeNull();
    expect(input().value).toBe("5");
    expect(document.activeElement).toBe(input());
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("jumps to the typed line, scrolls it into view, and closes", async () => {
    const { view, handle, onClose, panel, input } = mountPanel(20);
    handle().openGotoLine();
    await nextTick();

    setInputValue(input(), "12");
    await nextTick();
    pressKey(input(), "Enter");
    await settleLeave(panel);

    const target = view.state.doc.line(12);
    expect(view.state.selection.main.head).toBe(target.from);
    expect(view.state.selection.main.empty).toBe(true);
    expect(panel()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the caret in place and shows a hint for an out-of-range line", async () => {
    const { view, handle, panel, input, errorText } = mountPanel(20);
    const before = view.state.selection.main.head;
    handle().openGotoLine();
    await nextTick();

    setInputValue(input(), "999");
    await nextTick();
    pressKey(input(), "Enter");
    await nextTick();

    expect(view.state.selection.main.head).toBe(before);
    expect(panel()).not.toBeNull();
    expect(errorText()).toBe("editor.gotoLine.outOfRange");
    expect(document.activeElement).toBe(input());
  });

  it("rejects non-numeric input, zero, and negative numbers", async () => {
    const { view, handle, panel, input, errorText } = mountPanel(20);
    const before = view.state.selection.main.head;
    handle().openGotoLine();
    await nextTick();

    for (const value of ["abc", "1.5", "1e3", "+5", "-5"]) {
      setInputValue(input(), value);
      await nextTick();
      pressKey(input(), "Enter");
      await nextTick();
      expect(view.state.selection.main.head).toBe(before);
      expect(panel()).not.toBeNull();
      expect(errorText()).toBe("editor.gotoLine.outOfRange");
    }
  });

  it("asks for a line number when the field is cleared", async () => {
    const { view, handle, panel, input, errorText } = mountPanel(20);
    const before = view.state.selection.main.head;
    handle().openGotoLine();
    await nextTick();

    setInputValue(input(), "   ");
    await nextTick();
    pressKey(input(), "Enter");
    await nextTick();

    expect(view.state.selection.main.head).toBe(before);
    expect(panel()).not.toBeNull();
    expect(errorText()).toBe("editor.gotoLine.empty");
  });

  it("clears a previous hint as soon as the input changes", async () => {
    const { handle, input, errorText } = mountPanel(20);
    handle().openGotoLine();
    await nextTick();

    setInputValue(input(), "999");
    await nextTick();
    pressKey(input(), "Enter");
    await nextTick();
    expect(errorText()).toBe("editor.gotoLine.outOfRange");

    pressKey(input(), "9");
    await nextTick();
    expect(errorText()).toBe("");
  });

  it("cancels on Escape and returns focus to the editor", async () => {
    const { view, handle, panel, onClose, onOpen, input } = mountPanel(20);
    const before = view.state.selection.main.head;
    handle().openGotoLine();
    await nextTick();

    pressKey(input(), "Escape");
    await settleLeave(panel);

    expect(panel()).toBeNull();
    expect(view.state.selection.main.head).toBe(before);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(view.dom.contains(document.activeElement)).toBe(true);
  });

  it("ignores the Enter that confirms an IME composition", async () => {
    const { view, handle, panel, input } = mountPanel(20);
    const before = view.state.selection.main.head;
    handle().openGotoLine();
    await nextTick();

    setInputValue(input(), "12");
    await nextTick();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true } as KeyboardEventInit));
    await nextTick();

    expect(view.state.selection.main.head).toBe(before);
    expect(panel()).not.toBeNull();
  });

  it("reports failure instead of opening when there is no editor view", async () => {
    const onOpen = vi.fn();
    let instance: PanelHandle | null = null;
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(EditorGotoLinePanel, {
              view: null,
              onOpen,
              ref: (el) => {
                if (el) instance = el as unknown as PanelHandle;
              },
            });
        },
      }),
    );
    app.mount(host);
    mounted.push({ app, host });

    expect((instance as unknown as PanelHandle).openGotoLine()).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    expect(host.querySelector(".editor-goto-line-panel")).toBeNull();
  });

  it("closes a previously opened panel from the exposed handle", async () => {
    const { handle, panel } = mountPanel(20);
    handle().openGotoLine();
    await nextTick();
    expect(panel()).not.toBeNull();

    expect(handle().closeGotoLine()).toBe(true);
    await settleLeave(panel);
    expect(panel()).toBeNull();
    expect(handle().closeGotoLine()).toBe(false);
  });
});
