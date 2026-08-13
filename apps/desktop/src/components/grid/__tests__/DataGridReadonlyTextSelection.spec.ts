// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DataGridReadonlyTextSelection from "../DataGridReadonlyTextSelection.vue";

const mountedRoots: HTMLDivElement[] = [];
const dataGridSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGrid.vue"), "utf8");

function mountSelection(options: { value?: string; expanded?: boolean } = {}) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  mountedRoots.push(root);
  const onClose = vi.fn();
  const onEscape = vi.fn();
  const app = createApp(DataGridReadonlyTextSelection, {
    value: options.value ?? "alpha-copy-test",
    expanded: options.expanded ?? false,
    onClose,
    onEscape,
  });
  app.mount(root);
  return { root, app, onClose, onEscape };
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.remove();
});

describe("DataGridReadonlyTextSelection", () => {
  it("closes a stale read-only selection when a result is replaced", () => {
    const resultWatcher = dataGridSource.match(/watch\(\s*\(\) => props\.result,\s*\(result, previousResult\) => \{[\s\S]*?\n\);/)?.[0] ?? "";

    expect(resultWatcher).toContain("if (isDataGridPrefixAppend(previousResult, result)) return;");
    expect(resultWatcher).toContain("closeReadonlyCellTextSelection();");
  });

  it("focuses and selects the complete read-only value on mount", async () => {
    const { root } = mountSelection();
    await nextTick();
    const input = root.querySelector("input");

    expect(input).not.toBeNull();
    expect(input?.readOnly).toBe(true);
    expect(input?.dataset.nativeClipboard).toBe("");
    expect(document.activeElement).toBe(input);
    expect(input?.selectionStart).toBe(0);
    expect(input?.selectionEnd).toBe("alpha-copy-test".length);
  });

  it("renders multiline or overflowing content in a read-only textarea", async () => {
    const value = "first line\nsecond line";
    const { root } = mountSelection({ value, expanded: true });
    await nextTick();
    const textarea = root.querySelector("textarea");

    expect(textarea?.value).toBe(value);
    expect(textarea?.readOnly).toBe(true);
    expect(textarea?.selectionStart).toBe(0);
    expect(textarea?.selectionEnd).toBe(value.length);
  });

  it("prevents paste and emits close signals for Escape and blur", async () => {
    const { root, onClose, onEscape } = mountSelection();
    await nextTick();
    const input = root.querySelector("input")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    input.dispatchEvent(paste);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    input.dispatchEvent(new FocusEvent("blur"));

    expect(paste.defaultPrevented).toBe(true);
    expect(input.value).toBe("alpha-copy-test");
    expect(onEscape).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
