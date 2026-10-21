// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import type { QuickOpenItem } from "@/composables/useQuickOpen";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), copy: vi.fn(), toast: vi.fn(), encoding: "utf8" }));
vi.mock("@/lib/backend/api", () => ({
  readExternalSqlFileSnapshot: async (...args: unknown[]) => ({ content: await mocks.read(...args), version: { contentHash: "original", modifiedNs: "1", sizeBytes: 34 }, encoding: mocks.encoding }),
  writeExternalSqlFile: mocks.write,
}));
vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: mocks.copy, clipboardLineEndings: (text: string) => text }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { fontSize: 13, fontFamily: "monospace", theme: "app" } }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: "pearl" } }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ editorFontTheme: () => [], loadEditorTheme: async () => [] }));

import QuickOpenFilePreview from "../QuickOpenFilePreview.vue";

function item(path = "/sql/first.sql", line = 2, column = 8): QuickOpenItem {
  return { id: `${path}:${line}`, type: "content_match", connectionId: "", label: "first.sql", searchText: "needle", filePath: path, line, column, matchText: "needle" };
}

const mounted: Array<{ app: App; host: HTMLElement }> = [];
function mountPreview(selected = item(), events: { onNavigate?: (direction: -1 | 1) => void; onOpen?: () => void; onClose?: () => void; onEditing?: (value: boolean) => void } = {}) {
  const props = reactive({ item: selected });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(QuickOpenFilePreview, { ...props, ...events }) });
  app.mount(host);
  mounted.push({ app, host });
  return { props, host, app };
}

async function settle() {
  await nextTick();
  await vi.advanceTimersByTimeAsync(100);
  await nextTick();
}

function editor(host: HTMLElement): EditorView {
  const element = host.querySelector<HTMLElement>(".cm-editor");
  expect(element).not.toBeNull();
  return EditorView.findFromDOM(element!)!;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label);
  expect(result).toBeDefined();
  return result!;
}

async function beginEditing(host: HTMLElement): Promise<EditorView> {
  button(host, "common.edit").click();
  await nextTick();
  await nextTick();
  return editor(host);
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.read.mockReset().mockResolvedValue("-- heading\nSELECT needle;\nSELECT 2;");
  mocks.write.mockReset().mockResolvedValue({ kind: "written", version: { contentHash: "saved", modifiedNs: "2", sizeBytes: 35 } });
  mocks.copy.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
  mocks.encoding = "utf8";
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.useRealTimers();
});

describe("quick-open file preview", () => {
  it("copies the selection, or the whole file when nothing is selected", async () => {
    const { host } = mountPreview();
    expect(button(host, "common.copy").disabled).toBe(true);
    await settle();
    button(host, "common.copy").click();
    await nextTick();
    expect(mocks.copy).toHaveBeenLastCalledWith("-- heading\nSELECT needle;\nSELECT 2;");
    const view = editor(host);
    const from = view.state.doc.line(2).from;
    view.dispatch({ selection: { anchor: from, head: from + 6 } });
    button(host, "common.copy").click();
    await nextTick();
    expect(mocks.copy).toHaveBeenLastCalledWith("SELECT");
    expect(mocks.toast).toHaveBeenCalledWith("grid.copied");
  });

  it("reports clipboard failures and keeps the file available", async () => {
    mocks.copy.mockRejectedValue(new Error("denied"));
    const { host } = mountPreview();
    await settle();
    button(host, "common.copy").click();
    await nextTick();
    expect(mocks.toast).toHaveBeenCalledWith("grid.copyFailed", 5000);
    expect(editor(host).state.doc.toString()).toContain("needle");
  });

  it("edits in place, supports undo/redo, and saves with the original version", async () => {
    const onEditing = vi.fn();
    const { host } = mountPreview(item(), { onEditing });
    await settle();
    const view = await beginEditing(host);
    expect(view.state.readOnly).toBe(false);
    expect(view.state.facet(EditorView.editable)).toBe(true);
    expect(onEditing).toHaveBeenLastCalledWith(true);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nSELECT 3;" } });
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).not.toContain("SELECT 3;");
    expect(redo(view)).toBe(true);
    button(host, "common.save").click();
    await nextTick();
    await nextTick();
    expect(mocks.write).toHaveBeenCalledWith("/sql/first.sql", "-- heading\nSELECT needle;\nSELECT 2;\nSELECT 3;", { expectedContentHash: "original", encoding: "utf8" });
    expect(editor(host)).toBe(view);
    expect(view.state.readOnly).toBe(true);
    expect(onEditing).toHaveBeenLastCalledWith(false);
    button(host, "common.copy").click();
    await nextTick();
    expect(mocks.copy).toHaveBeenLastCalledWith(view.state.sliceDoc());
    await beginEditing(host);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n-- second edit" } });
    button(host, "common.save").click();
    await nextTick();
    expect(mocks.write).toHaveBeenLastCalledWith("/sql/first.sql", expect.stringContaining("second edit"), { expectedContentHash: "saved", encoding: "utf8" });
  });

  it("restores the last saved content on cancel without writing a file", async () => {
    const { host } = mountPreview();
    await settle();
    const view = await beginEditing(host);
    const original = view.state.doc.toString();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "changed" } });
    button(host, "common.cancel").click();
    await nextTick();
    expect(view.state.doc.toString()).toBe(original);
    expect(view.state.readOnly).toBe(true);
    expect(mocks.write).not.toHaveBeenCalled();
    await beginEditing(host);
    expect(undo(view)).toBe(false);
  });

  it("uses Enter and arrow keys for editing, and saves with Ctrl+S", async () => {
    const onOpen = vi.fn();
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const { host } = mountPreview(item(), { onOpen, onNavigate, onClose });
    await settle();
    const view = await beginEditing(host);
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(view.state.doc.lines).toBe(4);
    view.focus();
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    await nextTick();
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it.each(["conflict", "missing", "error"])("keeps the draft when saving returns %s", async (kind) => {
    if (kind === "error") mocks.write.mockRejectedValue(new Error("write denied"));
    else mocks.write.mockResolvedValue({ kind });
    const { host } = mountPreview();
    await settle();
    const view = await beginEditing(host);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "my draft" } });
    button(host, "common.save").click();
    await nextTick();
    await nextTick();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.state.doc.toString()).toBe("my draft");
    expect(view.state.readOnly).toBe(false);
    expect(button(host, "common.cancel").disabled).toBe(false);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("disables editing and prevents duplicate saves while a write is pending", async () => {
    let resolveWrite!: (value: unknown) => void;
    mocks.write.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const { host } = mountPreview();
    await settle();
    const view = await beginEditing(host);
    view.dispatch({ changes: { from: 0, insert: "-- draft\n" } });
    button(host, "common.save").click();
    await nextTick();
    expect(view.state.readOnly).toBe(true);
    expect(button(host, "common.save").disabled).toBe(true);
    expect(button(host, "common.cancel").disabled).toBe(true);
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(mocks.write).toHaveBeenCalledOnce();
    resolveWrite({ kind: "written", version: { contentHash: "saved", modifiedNs: "2", sizeBytes: 44 } });
    await nextTick();
    await nextTick();
    expect(button(host, "common.edit")).toBeDefined();
  });

  it.each(["\r\n", "\n", "\r"])("preserves %j line endings and the detected encoding", async (lineEnding) => {
    mocks.encoding = "utf16le";
    mocks.read.mockResolvedValue(`SELECT 1;${lineEnding}SELECT 2;`);
    const { host } = mountPreview();
    await settle();
    const view = await beginEditing(host);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nSELECT 3;" } });
    button(host, "common.save").click();
    await nextTick();
    expect(mocks.write).toHaveBeenCalledWith("/sql/first.sql", `SELECT 1;${lineEnding}SELECT 2;${lineEnding}SELECT 3;`, { expectedContentHash: "original", encoding: "utf16le" });
  });

  it("allows editing and saving an initially empty file", async () => {
    mocks.read.mockResolvedValue("");
    const { host } = mountPreview();
    await settle();
    const view = await beginEditing(host);
    view.dispatch({ changes: { from: 0, insert: "SELECT 1;" } });
    button(host, "common.save").click();
    await nextTick();
    await nextTick();
    expect(editor(host).state.doc.toString()).toBe("SELECT 1;");
    expect(host.textContent).not.toContain("quickOpen.previewEmpty");
  });

  it.each([
    ["Escape", "close", undefined],
    ["Enter", "open", undefined],
    ["ArrowUp", "navigate", -1],
    ["ArrowDown", "navigate", 1],
  ] as const)("forwards %s from the focused editor to the search dialog", async (key, event, direction) => {
    const onNavigate = vi.fn();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const { host } = mountPreview(item(), { onNavigate, onOpen, onClose });
    await settle();
    const view = editor(host);
    view.focus();
    const keyboardEvent = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(keyboardEvent);
    expect(keyboardEvent.defaultPrevented).toBe(true);
    if (event === "navigate") expect(onNavigate).toHaveBeenCalledWith(direction);
    else expect(event === "open" ? onOpen : onClose).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("-- heading\nSELECT needle;\nSELECT 2;");
  });

  it("keeps shifted arrow selection available for copying preview text", async () => {
    const onNavigate = vi.fn();
    const { host } = mountPreview(item(), { onNavigate });
    await settle();
    const view = editor(host);
    view.focus();
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
    expect(view.state.selection.main.empty).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it.each(["😀 prefix ", "😀🧪 前缀 "])("maps character columns to UTF-16 after %s", async (prefix) => {
    mocks.read.mockResolvedValue(`${prefix}needle`);
    const { host } = mountPreview(item(undefined, 1, [...prefix].length + 1));
    await settle();
    expect(editor(host).state.selection.main.head).toBe(prefix.length);
    expect(host.querySelector(".cm-preview-match")?.textContent).toBe("needle");
  });

  it("reads the full file, shows the selected hit, and keeps the editor read-only", async () => {
    const { host } = mountPreview();
    expect(host.textContent).toContain("common.loading");
    await settle();
    const view = editor(host);
    expect(mocks.read).toHaveBeenCalledWith("/sql/first.sql", 32 * 1024 * 1024);
    expect(view.state.doc.toString()).toContain("SELECT 2;");
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
    expect(view.state.facet(EditorView.editable)).toBe(false);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from + 7);
    expect(host.querySelector(".cm-preview-match")?.textContent).toBe("needle");
    expect(view.contentDOM.getAttribute("aria-label")).toBe("/sql/first.sql");
  });

  it("moves to another line of the same file without reading again", async () => {
    const { host, props } = mountPreview();
    await settle();
    const firstEditor = editor(host);
    props.item = { ...item(undefined, 3, 8), matchText: "2" };
    await nextTick();
    expect(editor(host)).toBe(firstEditor);
    expect(editor(host).state.selection.main.head).toBe(firstEditor.state.doc.line(3).from + 7);
    expect(host.querySelector(".cm-preview-match")?.textContent).toBe("2");
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("debounces rapid file selection and ignores a stale read", async () => {
    let resolveFirst!: (text: string) => void;
    mocks.read.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { host, props } = mountPreview();
    await settle();
    props.item = item("/sql/skipped.sql");
    await nextTick();
    props.item = item("/sql/latest.sql", 1, 1);
    mocks.read.mockResolvedValue("latest");
    await settle();
    resolveFirst("stale");
    await settle();
    expect(mocks.read.mock.calls.map(([path]) => path)).toEqual(["/sql/first.sql", "/sql/latest.sql"]);
    expect(editor(host).state.doc.toString()).toBe("latest");
  });

  it.each(["", null])("shows a readable state for an empty or unavailable file: %s", async (text) => {
    if (text === null) mocks.read.mockRejectedValue(new Error("private path details"));
    else mocks.read.mockResolvedValue(text);
    const { host } = mountPreview();
    await settle();
    expect(host.textContent).toContain(text === null ? "quickOpen.previewFailed" : "quickOpen.previewEmpty");
    expect(host.textContent).not.toContain("private path details");
    expect(host.querySelector(".cm-editor")).toBeNull();
  });

  it("previews filename-only hits from the beginning and clamps outdated locations", async () => {
    const { host, props } = mountPreview(item(undefined, 0));
    await settle();
    expect(editor(host).state.selection.main.head).toBe(0);
    expect(host.querySelector(".cm-preview-match")).toBeNull();
    props.item = item(undefined, 999, 999);
    await nextTick();
    expect(editor(host).state.selection.main.head).toBe(editor(host).state.doc.length);
  });

  it("cancels a pending read when the preview closes", async () => {
    const { app } = mountPreview();
    app.unmount();
    await settle();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
