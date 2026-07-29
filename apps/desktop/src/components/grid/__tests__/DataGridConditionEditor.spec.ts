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

  it("keeps expanded input first-line indent without forced word breaks", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");
    const expandedInputCss = source.match(/\.data-grid-topbar-condition-input--expanded\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(expandedInputCss).toContain("padding:");
    expect(expandedInputCss).toContain("text-indent: var(--data-grid-condition-prefix-indent)");
    expect(expandedInputCss).toContain("overflow-wrap: normal");
    expect(source).toContain("white-space:pre-wrap;overflow-wrap:normal;");
  });

  it("keeps the expanded condition label readable over wrapped content", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");
    const floatingControls = source.match(/data-grid-topbar-condition-floating-controls[^"]*/)?.[0];
    const floatingLabelCss = source.match(/\.data-grid-topbar-condition-label--floating\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(floatingControls).toContain("z-[2]");
    expect(source).toContain("data-grid-topbar-condition-label--floating");
    expect(floatingLabelCss).toContain("text-shadow:");
    expect(floatingLabelCss).not.toContain("padding-right:");
    expect(floatingLabelCss).not.toContain("box-shadow:");
  });

  it("scrolls the caret into view after accepting a long completion", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");

    expect(source).toContain("function scrollCaretIntoView()");
    expect(source).toContain("function focusAfterAccept()");
    expect(source).toContain("void nextTick(scrollCaretIntoView)");
    expect(source).toContain('if (action === "accept") focusAfterAccept()');
  });

  it("positions suggestions below the measured expanded editor height", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGridConditionEditor.vue"), "utf8");
    const expandedPaneCss = source.match(/\.data-grid-topbar-condition-pane--expanded\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

    expect(source).toContain("bottom: expandedRect.value.top + expandedHeight.value");
    expect(expandedPaneCss).toContain("transition: box-shadow 150ms ease");
    expect(expandedPaneCss).not.toContain("height 150ms");
  });
});
