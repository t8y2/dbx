// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  highlight: vi.fn<(content: string) => string>(() => ""),
  copyToClipboard: vi.fn<(_text: string) => Promise<void>>(async () => {}),
  toast: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { sqlFormatter: {} } }) }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({
  createShikiSqlHighlighter: async () => (content: string) => mocks.highlight(content),
}));

vi.mock("@/lib/common/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/common/clipboard")>();
  return { ...actual, copyToClipboard: mocks.copyToClipboard };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup(_, { attrs, slots }) {
        return () => h("button", attrs, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/tooltip", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = () =>
    defineComponent({
      setup:
        (_, { slots }) =>
        () =>
          h("div", slots.default?.()),
    });
  return { Tooltip: passthrough(), TooltipTrigger: passthrough(), TooltipContent: passthrough() };
});

import SqlPreviewPanel from "@/components/editor/SqlPreviewPanel.vue";

const SQL = "UPDATE users SET name = 'Ada' WHERE id = 1;";

let app: App<Element> | null = null;
let host: HTMLDivElement | null = null;

async function flushUi() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountPanel(sql = SQL) {
  host = document.createElement("div");
  document.body.append(host);
  app = createApp(SqlPreviewPanel, { sql });
  app.mount(host);
  await flushUi();
  return host;
}

function previewText(host: HTMLElement): HTMLPreElement {
  const pre = host.querySelector("pre");
  if (!pre) throw new Error("SQL preview text not found");
  return pre;
}

function dispatchSelectAll(target: HTMLElement, modifiers: KeyboardEventInit = { ctrlKey: true }) {
  const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

function dispatchCopy(target: HTMLElement, modifiers: KeyboardEventInit = { ctrlKey: true }) {
  const event = new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

/** Builds a selection the way a mouse drag would: a sub-range of the preview text. */
function dragSelect(pre: HTMLElement, start: number, end: number) {
  const textNode = pre.firstChild;
  if (!textNode) throw new Error("preview text node not found");
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return selection;
}

beforeEach(() => {
  mocks.highlight.mockImplementation(() => "");
  mocks.copyToClipboard.mockClear();
  mocks.copyToClipboard.mockImplementation(async () => {});
  mocks.toast.mockClear();
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
  mocks.highlight.mockClear();
  mocks.copyToClipboard.mockClear();
  mocks.toast.mockClear();
});

describe("SqlPreviewPanel select all", () => {
  it("selects the preview text on Ctrl+A instead of leaving the shortcut to the data grid", async () => {
    const mounted = await mountPanel();
    const pre = previewText(mounted);

    expect(pre.getAttribute("data-native-clipboard")).toBe("");
    expect(pre.tabIndex).toBe(0);
    pre.focus();
    expect(document.activeElement).toBe(pre);

    const event = dispatchSelectAll(pre);
    const selection = window.getSelection();

    expect(event.defaultPrevented).toBe(true);
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.toString()).toBe(SQL);
    expect(selection?.anchorNode && pre.contains(selection.anchorNode)).toBe(true);
  });

  it("supports Cmd+A and selects the highlighted SQL", async () => {
    mocks.highlight.mockImplementation((content) => `<span class="tok">${content}</span>`);
    const mounted = await mountPanel();
    const pre = previewText(mounted);
    expect(pre.innerHTML).toContain('class="tok"');

    const event = dispatchSelectAll(pre, { metaKey: true });
    const selection = window.getSelection();

    expect(event.defaultPrevented).toBe(true);
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.toString()).toBe(SQL);
  });

  it("keeps the shortcut untouched for other modifiers and keys", async () => {
    const mounted = await mountPanel();
    const pre = previewText(mounted);

    expect(dispatchSelectAll(pre, { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(dispatchSelectAll(pre, { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(dispatchSelectAll(pre, { ctrlKey: false }).defaultPrevented).toBe(false);
    expect(window.getSelection()?.rangeCount ?? 0).toBe(0);
  });

  it("lets the event keep bubbling so the surrounding grid can observe it", async () => {
    const mounted = await mountPanel();
    const pre = previewText(mounted);
    const bubbled = vi.fn();
    mounted.addEventListener("keydown", bubbled);

    dispatchSelectAll(pre);

    expect(bubbled).toHaveBeenCalledOnce();
  });
});

describe("SqlPreviewPanel copy", () => {
  it("copies a Ctrl+A selection through the app clipboard instead of the unreliable native path", async () => {
    const mounted = await mountPanel();
    const pre = previewText(mounted);

    pre.focus();
    expect(dispatchSelectAll(pre).defaultPrevented).toBe(true);

    const copied = dispatchCopy(pre);
    await flushUi();

    // The webview never lands a programmatically built selection on the system
    // clipboard, which is why Ctrl+A followed by Ctrl+C used to toast success and
    // copy nothing (#12167).
    expect(copied.defaultPrevented).toBe(true);
    expect(mocks.copyToClipboard).toHaveBeenCalledTimes(1);
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(SQL);
    expect(mocks.toast).toHaveBeenCalledWith("grid.copied");
  });

  it("copies the whole preview when Ctrl+C arrives without a selection", async () => {
    const mounted = await mountPanel();
    const pre = previewText(mounted);

    const copied = dispatchCopy(pre);
    await flushUi();

    expect(copied.defaultPrevented).toBe(true);
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(SQL);
    expect(mocks.toast).toHaveBeenCalledWith("grid.copied");
  });

  it("copies only the text the user actually highlighted", async () => {
    const mounted = await mountPanel();
    const pre = previewText(mounted);

    dragSelect(pre, 0, 7);
    const copied = dispatchCopy(pre);
    await flushUi();

    expect(copied.defaultPrevented).toBe(true);
    expect(mocks.copyToClipboard).toHaveBeenCalledTimes(1);
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(SQL.slice(0, 7));
  });

  it("copies only the highlighted SQL when the formatted view is active", async () => {
    mocks.highlight.mockImplementation((content) => `<span class="tok">${content}</span>`);
    const mounted = await mountPanel();
    const pre = previewText(mounted);
    expect(pre.innerHTML).toContain('class="tok"');

    dragSelect(pre.querySelector("span") ?? pre, 0, 7);
    const copied = dispatchCopy(pre);
    await flushUi();

    expect(copied.defaultPrevented).toBe(true);
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(SQL.slice(0, 7));
  });

  it("supports Cmd+C on macOS", async () => {
    const mounted = await mountPanel();
    const pre = previewText(mounted);

    const copied = dispatchCopy(pre, { metaKey: true });
    await flushUi();

    expect(copied.defaultPrevented).toBe(true);
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(SQL);
  });

  it("falls back to the whole preview when the selection leaked outside it", async () => {
    const mounted = await mountPanel();
    const pre = previewText(mounted);
    const outside = document.createElement("div");
    outside.textContent = "grid cell";
    mounted.append(outside);
    const outsideNode = outside.firstChild;
    const previewNode = pre.firstChild;
    if (!outsideNode || !previewNode) throw new Error("selection anchors not found");

    const range = document.createRange();
    range.setStart(previewNode, 0);
    range.setEnd(outsideNode, 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const copied = dispatchCopy(pre);
    await flushUi();
    outside.remove();

    expect(copied.defaultPrevented).toBe(true);
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(SQL);
  });

  it("keeps the shortcut untouched for other modifiers", async () => {
    const mounted = await mountPanel();
    const pre = previewText(mounted);

    expect(dispatchCopy(pre, { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(dispatchCopy(pre, { ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    expect(dispatchCopy(pre, { ctrlKey: false }).defaultPrevented).toBe(false);
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("stops the copy shortcut from reaching the surrounding data grid", async () => {
    const mounted = await mountPanel();
    const pre = previewText(mounted);
    const bubbled = vi.fn();
    mounted.addEventListener("keydown", bubbled);

    const copied = dispatchCopy(pre);
    await flushUi();

    expect(copied.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(mocks.copyToClipboard).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failure toast when the app clipboard rejects", async () => {
    mocks.copyToClipboard.mockImplementationOnce(async () => {
      throw new Error("clipboard unavailable");
    });
    const mounted = await mountPanel();
    const pre = previewText(mounted);

    dispatchCopy(pre);
    await flushUi();

    expect(mocks.toast.mock.calls[0]?.[0]).toBe("grid.copyFailed");
  });
});
