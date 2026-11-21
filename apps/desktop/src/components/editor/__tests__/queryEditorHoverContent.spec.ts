// @vitest-environment happy-dom

import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryEditorHoverContent } from "../queryEditorHoverContent";

const { copy, highlight, createHighlighter, mountLayout, destroyLayout } = vi.hoisted(() => ({ copy: vi.fn(), highlight: vi.fn(), createHighlighter: vi.fn(), mountLayout: vi.fn(), destroyLayout: vi.fn() }));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: copy }));
vi.mock("@/lib/sql/sqlHighlighter", () => ({ createShikiSqlHighlighter: createHighlighter }));
vi.mock("@/lib/editor/sqlHoverLayout", () => ({ constrainSqlHoverLayout: () => ({ mount: mountLayout, destroy: destroyLayout }) }));
const cleanups: Array<() => void> = [];

beforeEach(() => {
  copy.mockResolvedValue(undefined);
  highlight.mockImplementation((sql: string) => `<pre>${sql}</pre>`);
  createHighlighter.mockResolvedValue(highlight);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  document.getSelection()?.removeAllRanges();
  vi.clearAllMocks();
});

function createHarness() {
  const isDark = ref(false);
  const toast = vi.fn();
  const t = vi.fn((key: string) => key);
  const content = createQueryEditorHoverContent({ isDark, toast, t: t as Parameters<typeof createQueryEditorHoverContent>[0]["t"] });
  function render(sql?: string, rows?: string[]) {
    const tooltip = content.createHoverDom("users", "TABLE", sql, rows);
    document.body.append(tooltip.dom);
    tooltip.mount?.();
    cleanups.push(() => {
      tooltip.destroy?.();
      tooltip.dom.remove();
    });
    return tooltip;
  }
  return { content, isDark, toast, t, render };
}

describe("QueryEditor hover content", () => {
  it("renders plain metadata safely without creating DDL controls", () => {
    const { render } = createHarness();
    const tooltip = render(undefined, ["<img src=x>"]);
    expect(tooltip.dom.textContent).toContain("<img src=x>");
    expect(tooltip.dom.querySelector("img")).toBeNull();
    expect(tooltip.dom.querySelector("button")).toBeNull();
    expect(mountLayout).not.toHaveBeenCalled();
  });

  it("copies normalized DDL without changing its displayed alignment", async () => {
    const { render, toast } = createHarness();
    const sql = "CREATE TABLE users (id    INTEGER);";
    const tooltip = render(sql);
    const button = tooltip.dom.querySelector<HTMLButtonElement>('button[aria-label="grid.copyDdl"]')!;
    const pointer = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    button.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true);
    button.click();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith("CREATE TABLE users (id INTEGER);"));
    expect(toast).toHaveBeenCalledWith("contextMenu.ddlCopied", 2000);
    expect(tooltip.dom.textContent).toContain(sql);
  });

  it("reports copy failures without dismissing the content", async () => {
    copy.mockRejectedValue(new Error("clipboard unavailable"));
    const { render, toast, t } = createHarness();
    const tooltip = render("SELECT 1");
    tooltip.dom.querySelector<HTMLButtonElement>('button[aria-label="grid.copyDdl"]')!.click();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("grid.copyFailed", 5000));
    expect(t).toHaveBeenCalledWith("grid.copyFailed", { message: "clipboard unavailable" });
    expect(tooltip.dom.isConnected).toBe(true);
  });

  it("removes its document copy listener and layout controller on destroy", () => {
    const { render } = createHarness();
    const tooltip = render("SELECT    1");
    const sqlContainer = tooltip.dom.querySelector(".whitespace-pre")!;
    const range = document.createRange();
    range.selectNodeContents(sqlContainer);
    document.getSelection()?.addRange(range);
    const clipboardData = { setData: vi.fn() };
    const copyEvent = () => {
      const event = new Event("copy", { cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: clipboardData });
      document.dispatchEvent(event);
      return event;
    };
    expect(copyEvent().defaultPrevented).toBe(true);
    expect(clipboardData.setData).toHaveBeenCalledWith("text/plain", "SELECT 1");
    tooltip.destroy?.();
    clipboardData.setData.mockClear();
    expect(copyEvent().defaultPrevented).toBe(false);
    expect(clipboardData.setData).not.toHaveBeenCalled();
    expect(mountLayout).toHaveBeenCalledOnce();
    expect(destroyLayout).toHaveBeenCalledOnce();
  });

  it("uses late-loaded highlighting and reads the current appearance", async () => {
    const { content, isDark, render } = createHarness();
    expect(render("SELECT 1").dom.querySelector("pre")).toBeNull();
    content.initializeHighlighter();
    await vi.waitFor(() => expect(createHighlighter).toHaveBeenCalled());
    render("SELECT 2");
    expect(highlight).toHaveBeenLastCalledWith("SELECT 2", "light");
    isDark.value = true;
    render("SELECT 3");
    expect(highlight).toHaveBeenLastCalledWith("SELECT 3", "dark");
  });

  it("keeps a plain-text fallback when the highlighter fails", async () => {
    createHighlighter.mockRejectedValue(new Error("unavailable"));
    const { content, render } = createHarness();
    content.initializeHighlighter();
    await vi.waitFor(() => expect(createHighlighter).toHaveBeenCalled());
    const tooltip = render("SELECT '<script>'");
    expect(tooltip.dom.textContent).toContain("SELECT '<script>'");
    expect(tooltip.dom.querySelector("script")).toBeNull();
    expect(highlight).not.toHaveBeenCalled();
  });

  it("keeps loaded highlighters local to each editor instance", async () => {
    const first = createHarness();
    const second = createHarness();
    first.content.initializeHighlighter();
    await vi.waitFor(() => expect(createHighlighter).toHaveBeenCalled());
    expect(first.render("SELECT 1").dom.querySelector("pre")).not.toBeNull();
    expect(second.render("SELECT 2").dom.querySelector("pre")).toBeNull();
  });
});
