// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  highlight: vi.fn<(content: string) => string>(() => ""),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { sqlFormatter: {} } }) }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({
  createShikiSqlHighlighter: async () => (content: string) => mocks.highlight(content),
}));

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

beforeEach(() => {
  mocks.highlight.mockImplementation(() => "");
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
  mocks.highlight.mockClear();
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
    const other = new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true, ctrlKey: true });
    pre.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
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
