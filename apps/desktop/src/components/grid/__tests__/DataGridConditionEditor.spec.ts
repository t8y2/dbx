// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import DataGridConditionEditor from "@/components/grid/DataGridConditionEditor.vue";
import type { DataGridConditionHistoryKind } from "@/lib/dataGrid/dataGridConditionHistory";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function mountEditor(kind: DataGridConditionHistoryKind, initialValue: string, options: { columns?: string[]; identifierQuote?: string } = {}) {
  const value = ref(initialValue);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(DataGridConditionEditor, {
            kind,
            modelValue: value.value,
            "onUpdate:modelValue": (nextValue: string) => (value.value = nextValue),
            historyScope: {},
            columns: options.columns,
            identifierQuote: options.identifierQuote,
          });
      },
    }),
  );
  app.mount(host);
  mountedApps.push({ app, host });
  return { value, input: host.querySelector("textarea") as HTMLTextAreaElement };
}

function mockTextareaMetrics(input: HTMLTextAreaElement, options: { clientWidth: number; scrollWidth?: number; clientHeight?: number; scrollHeight?: number }) {
  Object.defineProperties(input, {
    clientWidth: { configurable: true, value: options.clientWidth },
    scrollWidth: { configurable: true, value: options.scrollWidth ?? options.clientWidth },
    clientHeight: { configurable: true, value: options.clientHeight ?? 24 },
    scrollHeight: { configurable: true, value: options.scrollHeight ?? 24 },
  });
  input.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: options.clientWidth,
      bottom: options.clientHeight ?? 24,
      width: options.clientWidth,
      height: options.clientHeight ?? 24,
      toJSON: () => ({}),
    }) as DOMRect;
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGridConditionEditor quote completion", () => {
  it("inserts paired quotes in WHERE and places the caret between them", async () => {
    const { value, input } = mountEditor("where", "id = ");
    input.focus();
    input.setSelectionRange(5, 5);

    const event = new KeyboardEvent("keydown", { key: "'", bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(value.value).toBe("id = ''");
    expect(input.selectionStart).toBe(6);
    expect(input.selectionEnd).toBe(6);
  });

  it("wraps selected WHERE text and skips an existing closing quote", async () => {
    const { value, input } = mountEditor("where", "name");
    input.focus();
    input.setSelectionRange(0, 4);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: '"', bubbles: true, cancelable: true }));
    await nextTick();

    expect(value.value).toBe('"name"');
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(5);

    input.setSelectionRange(5, 5);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: '"', bubbles: true, cancelable: true }));
    await nextTick();
    expect(value.value).toBe('"name"');
    expect(input.selectionStart).toBe(6);
  });

  it("does not intercept quotes in ORDER BY", () => {
    const { value, input } = mountEditor("orderBy", "name");
    input.focus();
    input.setSelectionRange(4, 4);

    const event = new KeyboardEvent("keydown", { key: '"', bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(value.value).toBe("name");
  });

  it("passes the textarea caret range through when accepting a suggestion", async () => {
    const { value, input } = mountEditor("where", "status = cus AND enabled = 1", { columns: ["customer_id"] });
    input.focus();
    input.setSelectionRange(12, 12);
    input.dispatchEvent(new Event("select", { bubbles: true }));
    await nextTick();
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain("customer_id"));

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    await nextTick();

    expect(value.value).toBe("status = customer_id AND enabled = 1");
    expect(input.selectionStart).toBe(20);
    expect(input.selectionEnd).toBe(20);
  });

  it("starts without an active suggestion and selects the first item on ArrowDown", async () => {
    const { value, input } = mountEditor("orderBy", "", { columns: ["name", "namespace"] });
    input.focus();
    input.value = "na";
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(2));
    expect(document.querySelector('[role="option"][aria-selected="true"]')).toBeNull();
    expect(value.value).toBe("na");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("name");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    expect(value.value).toBe("name");
  });

  it("does not select a suggestion just because the dropdown appears under the mouse", async () => {
    const { value, input } = mountEditor("orderBy", "", { columns: ["name", "namespace"] });
    input.focus();
    input.value = "na";
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(2));
    const firstOption = document.querySelector('[role="option"]') as HTMLElement;
    firstOption.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector('[role="option"][aria-selected="true"]')).toBeNull();
    expect(firstOption.className).not.toContain("bg-gray-200");
    expect(firstOption.className).not.toContain("bg-accent");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    expect(value.value).toBe("na");

    const secondEditor = mountEditor("orderBy", "", { columns: ["name", "namespace"] });
    secondEditor.input.focus();
    secondEditor.input.value = "na";
    secondEditor.input.setSelectionRange(2, 2);
    secondEditor.input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(2));
    const nextFirstOption = document.querySelector('[role="option"]') as HTMLElement;
    nextFirstOption.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("name");
  });

  it("keeps expanded input first-line indent and wraps long tokens", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");
    const expandedInputCss = source.match(/\.data-grid-topbar-condition-input--expanded\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(expandedInputCss).toContain("padding:");
    expect(expandedInputCss).toContain("0.0625rem 0.125rem");
    expect(expandedInputCss).toContain("text-indent: var(--data-grid-condition-prefix-indent)");
    expect(expandedInputCss).toContain("overflow-wrap: anywhere");
    expect(source).toContain("white-space:pre-wrap;overflow-wrap:anywhere;");
    expect(source).toContain("text-indent:${style.textIndent};");
    expect(source).toContain("textIndent: rect.prefix");
    expect(source).toContain("width: Math.max(1, rect.width - 8)");
    expect(source).toContain("function fitExpandedHeightToOverlay()");
    expect(source).toContain("expandedHeight.value + overflow");
  });

  it("keeps the expanded condition label readable over wrapped content", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");
    const floatingControls = source.match(/data-grid-topbar-condition-floating-controls[^"]*/)?.[0];
    const floatingLabelCss = source.match(/\.data-grid-topbar-condition-label--floating\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
    const compactFloatingLabelCss = source.match(/\.data-grid-topbar-condition-label--floating\.data-grid-topbar-condition-label--compact\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(floatingControls).toContain("z-[2]");
    expect(source).toContain("data-grid-topbar-condition-label--floating");
    expect(source).toContain("label.scrollWidth + 4");
    expect(floatingLabelCss).toContain("text-shadow:");
    expect(floatingLabelCss).not.toContain("padding-right:");
    expect(floatingLabelCss).not.toContain("box-shadow:");
    expect(compactFloatingLabelCss).toContain("max-width: 5rem");
    expect(compactFloatingLabelCss).toContain("opacity: 1");
  });

  it("keeps dark condition styles scoped to their target elements", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");

    expect(source).not.toContain(":global(.dark) .data-grid");
    expect(source).toContain(":global(.dark .data-grid-topbar-condition-label--floating)");
    expect(source).toContain(":global(.dark .data-grid-topbar-condition-pane--expanded)");
  });

  it("scrolls the caret into view after accepting a long completion", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");

    expect(source).toContain("function scrollCaretIntoView()");
    expect(source).toContain("const hasVerticalOverflow = target.scrollHeight > target.clientHeight + 4");
    expect(source).toContain("const hasHorizontalOverflow = target.scrollWidth > target.clientWidth + 1");
    expect(source).toContain("target.scrollTop = 0");
    expect(source).toContain("const caretLeft = caretMarker.offsetLeft");
    expect(source).toContain("target.scrollLeft");
    expect(source).toContain("function scheduleCaretIntoView()");
    expect(source).toContain("function focusAfterAccept()");
    expect(source).toContain("requestAnimationFrame(() => scrollCaretIntoView())");
    expect(source).toContain("scheduleCaretIntoView()");
    expect(source).toContain('if (action === "accept") focusAfterAccept()');
  });

  it("also keeps the caret visible after regular input wraps", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");
    const onInputBody = source.match(/function onInput\(event: Event\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(onInputBody).toContain("resizeEditor(true)");
    expect(onInputBody).toContain("updateSuggestionPosition()");
    expect(onInputBody).toContain("scheduleCaretIntoView()");
  });

  it("keeps the caret visible after switching focus into the expanded editor", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");
    const focusTransferBody = source.match(/if \(nextExpanded && document\.activeElement === input && !composing\.value\) \{(?<body>[\s\S]*?)\n    \}/)?.groups?.body;

    expect(focusTransferBody).toContain("const start = selectionStart.value");
    expect(focusTransferBody).toContain("overlay.setSelectionRange(start, end)");
    expect(focusTransferBody).toContain("overlay.focus({ preventScroll: true })");
    expect(focusTransferBody).toContain("scheduleCaretIntoView()");
  });

  it("keeps the caret visible after collapsing the expanded editor back to one line", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");
    const collapseTransferBody = source.match(/if \(!nextExpanded && overlayFocused && !composing\.value\) \{(?<body>[\s\S]*?)\n    \}/)?.groups?.body;

    expect(collapseTransferBody).toContain("const start = selectionStart.value");
    expect(collapseTransferBody).toContain("input.setSelectionRange(start, end)");
    expect(collapseTransferBody).toContain("input.focus({ preventScroll: true })");
    expect(collapseTransferBody!.indexOf("input.focus({ preventScroll: true })")).toBeLessThan(collapseTransferBody!.indexOf("input.setSelectionRange(start, end)"));
    expect(collapseTransferBody).toContain("scheduleCaretIntoView()");
  });

  it("preserves continuous input when the expanded editor collapses", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const textWidth = (this.textContent?.length ?? 0) * 8;
      const width = this.classList.contains("data-grid-topbar-condition-pane--expanded") ? 160 : textWidth;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 24, width, height: 24, toJSON: () => ({}) } as DOMRect;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const { value, input } = mountEditor("where", "abcdefghijklmnopqrstuvwxyz0123456789");
    mockTextareaMetrics(input, { clientWidth: 80, scrollWidth: 320 });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event("select", { bubbles: true }));
    input.dispatchEvent(new Event("focus", { bubbles: true }));

    await nextTick();
    await nextTick();
    const overlay = document.body.querySelector(".data-grid-topbar-condition-input--expanded") as HTMLTextAreaElement | null;
    expect(overlay).toBeTruthy();

    overlay!.value = "i";
    overlay!.setSelectionRange(1, 1);
    overlay!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await nextTick();

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(1);
    input.value = "id";
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    expect(value.value).toBe("id");
    expect(input.selectionStart).toBe(2);
    vi.unstubAllGlobals();
  });

  it("preserves the caret offset when focus moves into the expanded textarea", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.classList.contains("data-grid-topbar-condition-pane--expanded") ? 160 : 140;
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 24, width, height: 24, toJSON: () => ({}) } as DOMRect;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const { input } = mountEditor("where", "abcdefghijklmnopqrstuvwxyz0123456789");
    mockTextareaMetrics(input, { clientWidth: 80, scrollWidth: 320 });
    input.focus();
    input.setSelectionRange(30, 30);
    input.dispatchEvent(new Event("select", { bubbles: true }));
    input.dispatchEvent(new Event("focus", { bubbles: true }));

    await nextTick();
    await nextTick();
    const overlay = document.body.querySelector(".data-grid-topbar-condition-input--expanded") as HTMLTextAreaElement | null;

    expect(overlay).toBeTruthy();
    expect(document.activeElement).toBe(overlay);
    expect(overlay?.selectionStart).toBe(30);
    expect(overlay?.selectionEnd).toBe(30);
    vi.unstubAllGlobals();
  });

  it("positions suggestions below the measured expanded editor height", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");
    const expandedPaneCss = source.match(/\.data-grid-topbar-condition-pane--expanded\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(source).toContain("bottom: expandedRect.value.top + expandedHeight.value");
    expect(expandedPaneCss).toContain("transition: box-shadow 150ms ease");
    expect(expandedPaneCss).not.toContain("height 150ms");
  });
});

describe("DataGridConditionEditor Chinese column matching", () => {
  function mountChineseColumns() {
    return mountEditor("where", "", { columns: ["总租金", "租赁日期", "amount"] });
  }

  async function typeToken(input: HTMLTextAreaElement, token: string) {
    input.focus();
    input.value = token;
    input.setSelectionRange(token.length, token.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("matches a single Han character anywhere in the column name", async () => {
    const { input } = mountChineseColumns();
    await typeToken(input, "金");

    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(1));
    expect(document.querySelector('[role="option"]')?.textContent).toContain("总租金");
  });

  it("matches pinyin initials and initials subsequences", async () => {
    const { input } = mountChineseColumns();
    await typeToken(input, "zzj");

    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(1));
    expect(document.querySelector('[role="option"]')?.textContent).toContain("总租金");

    await typeToken(input, "zj");
    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(1));
    expect(document.querySelector('[role="option"]')?.textContent).toContain("总租金");
  });

  it("still matches plain English columns", async () => {
    const { input } = mountChineseColumns();
    await typeToken(input, "am");

    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(1));
    expect(document.querySelector('[role="option"]')?.textContent).toContain("amount");
  });
});
