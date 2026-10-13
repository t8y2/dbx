// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { QuickOpenItem } from "@/composables/useQuickOpen";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ readExternalSqlFile: mocks.read }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { fontSize: 13, fontFamily: "monospace", theme: "app" } }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: "pearl" } }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ editorFontTheme: () => [], loadEditorTheme: async () => [] }));

import QuickOpenFilePreview from "../QuickOpenFilePreview.vue";

function item(path = "/sql/first.sql", line = 2, column = 8): QuickOpenItem {
  return { id: `${path}:${line}`, type: "content_match", connectionId: "", label: "first.sql", searchText: "needle", filePath: path, line, column, matchText: "needle" };
}

const mounted: Array<{ app: App; host: HTMLElement }> = [];
function mountPreview(selected = item()) {
  const props = reactive({ item: selected });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(QuickOpenFilePreview, props) });
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

beforeEach(() => {
  vi.useFakeTimers();
  mocks.read.mockReset().mockResolvedValue("-- heading\nSELECT needle;\nSELECT 2;");
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.useRealTimers();
});

describe("quick-open file preview", () => {
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
