// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, shallowRef } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { useConnectionStore } from "@/stores/connectionStore";
import type { QueryEditorProps } from "../queryEditorTypes";

vi.mock("@/lib/common/clipboard", () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  readTextFromClipboard: vi.fn().mockResolvedValue(""),
}));

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

async function mountEditor(modelValue: string, overrides: Partial<QueryEditorProps> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  useConnectionStore();
  settingsStore.editorSettings.showExecutionTargetPicker = false;
  settingsStore.editorSettings.executeMode = "current";
  settingsStore.editorSettings.executeAllOnBlankLine = false;
  // Explicit modifiers keep the keymap deterministic on every platform.
  settingsStore.editorSettings.shortcuts.toggleBookmark = "Ctrl+Alt+B";
  settingsStore.editorSettings.shortcuts.nextBookmark = "Ctrl+Alt+J";
  settingsStore.editorSettings.shortcuts.previousBookmark = "Ctrl+Alt+K";
  const props = reactive<QueryEditorProps>({ modelValue, tabId: "bookmarks", databaseType: "mysql", dialect: "mysql", autoFocus: false, ...overrides });
  const editor = shallowRef<InstanceType<typeof QueryEditor>>();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        ...props,
        ref: editor,
        "onUpdate:modelValue": (value: string) => {
          props.modelValue = value;
        },
      }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
  const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  return { view, host, props, settingsStore };
}

function pressBookmarkShortcut(view: EditorView, key: string, keyCode: number): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, keyCode, code: key, ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(event, "keyCode", { get: () => keyCode });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function placeCursor(view: EditorView, offset: number) {
  view.dispatch({ selection: { anchor: offset } });
}

function visibleBookmarkMarkerCount(host: HTMLElement): number {
  return [...host.querySelectorAll<HTMLElement>(".cm-bookmark-gutter .cm-gutterElement")].filter((element) => element.style.visibility !== "hidden" && element.querySelector(".cm-bookmark-marker")).length;
}

describe("QueryEditor line bookmarks", () => {
  const SQL = "one\ntwo\nthree\nfour";
  const lineStart = (lineNumber: number) =>
    SQL.split("\n")
      .slice(0, lineNumber - 1)
      .reduce((offset, line) => offset + line.length + 1, 0);

  it("toggles a bookmark from the keyboard and renders its gutter marker", async () => {
    const { view, host } = await mountEditor(SQL);
    const bookmarkGutter = host.querySelector(".cm-bookmark-gutter");
    const lineNumbers = host.querySelector(".cm-lineNumbers");
    expect(bookmarkGutter).not.toBeNull();
    expect(lineNumbers).not.toBeNull();
    expect(bookmarkGutter!.compareDocumentPosition(lineNumbers!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    placeCursor(view, SQL.indexOf("two") + 1);
    pressBookmarkShortcut(view, "b", 66);
    await nextTick();

    expect(visibleBookmarkMarkerCount(host)).toBe(1);
  });

  it("moves between bookmarks and wraps around", async () => {
    const { view } = await mountEditor(SQL);
    placeCursor(view, SQL.indexOf("two"));
    pressBookmarkShortcut(view, "b", 66);
    await nextTick();
    placeCursor(view, SQL.indexOf("four"));
    pressBookmarkShortcut(view, "b", 66);
    await nextTick();
    placeCursor(view, 0);

    pressBookmarkShortcut(view, "j", 74);
    await nextTick();
    expect(view.state.selection.main.head).toBe(lineStart(2));

    pressBookmarkShortcut(view, "j", 74);
    await nextTick();
    expect(view.state.selection.main.head).toBe(lineStart(4));

    pressBookmarkShortcut(view, "j", 74);
    await nextTick();
    expect(view.state.selection.main.head).toBe(lineStart(2));

    pressBookmarkShortcut(view, "k", 75);
    await nextTick();
    expect(view.state.selection.main.head).toBe(lineStart(4));
  });

  it("keeps bookmarks per tab and does not leak them into a newly opened tab", async () => {
    const { view, host, props } = await mountEditor(SQL);
    placeCursor(view, SQL.indexOf("two"));
    pressBookmarkShortcut(view, "b", 66);
    await nextTick();
    expect(visibleBookmarkMarkerCount(host)).toBe(1);

    props.tabId = "bookmarks-b";
    props.modelValue = "alpha\nbeta\ngamma";
    await nextTick();
    await nextTick();
    expect(visibleBookmarkMarkerCount(host)).toBe(0);

    placeCursor(view, 0);
    pressBookmarkShortcut(view, "b", 66);
    await nextTick();
    expect(visibleBookmarkMarkerCount(host)).toBe(1);

    props.tabId = "bookmarks";
    props.modelValue = SQL;
    await nextTick();
    await nextTick();
    expect(visibleBookmarkMarkerCount(host)).toBe(1);

    placeCursor(view, 0);
    pressBookmarkShortcut(view, "j", 74);
    await nextTick();
    expect(view.state.selection.main.head).toBe(lineStart(2));
  });

  it("leaves the cursor alone when no bookmark exists", async () => {
    const { view } = await mountEditor(SQL);
    placeCursor(view, SQL.indexOf("three"));
    const cursor = view.state.selection.main.head;

    pressBookmarkShortcut(view, "j", 74);
    await nextTick();

    expect(view.state.selection.main.head).toBe(cursor);
  });
});
