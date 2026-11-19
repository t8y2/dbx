// @vitest-environment happy-dom

import { queryEditorBookmarkLines } from "@/lib/editor/codemirrorBookmarks";
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
  const bookmarkChanges = vi.fn((lines: number[], tabId?: string) => {
    if (props.bookmarkLines !== undefined && tabId === props.tabId) props.bookmarkLines = lines;
  });
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        ...props,
        ref: editor,
        onBookmarksChange: bookmarkChanges,
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
  return { view, host, props, settingsStore, editor, bookmarkChanges };
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
  it("restores persisted lines, tracks edits, and survives a fresh editor mount", async () => {
    const first = await mountEditor("one\ntwo\nthree", { bookmarkLines: [2, 3] });
    await nextTick();
    expect(queryEditorBookmarkLines(first.view)).toEqual([2, 3]);
    first.view.dispatch({ changes: { from: 0, insert: "new\n" } });
    await nextTick();
    expect(first.props.bookmarkLines).toEqual([3, 4]);
    placeCursor(first.view, first.view.state.doc.line(3).from);
    pressBookmarkShortcut(first.view, "b", 66);
    await nextTick();
    expect(first.props.bookmarkLines).toEqual([4]);
    const restored = await mountEditor(first.props.modelValue, { bookmarkLines: [...first.props.bookmarkLines!] });
    await nextTick();
    expect(queryEditorBookmarkLines(restored.view)).toEqual([4]);
  });

  it("keeps saved lines while file content hydrates and isolates tab swaps", async () => {
    const { view, props, bookmarkChanges } = await mountEditor("", { bookmarkLines: [3] });
    expect(props.bookmarkLines).toEqual([3]);
    props.modelValue = "one\ntwo\nthree";
    await nextTick();
    await nextTick();
    expect(queryEditorBookmarkLines(view)).toEqual([3]);
    bookmarkChanges.mockClear();
    Object.assign(props, { tabId: "second", modelValue: "other\nfile", bookmarkLines: [1] });
    await nextTick();
    expect(bookmarkChanges).not.toHaveBeenCalled();
    await nextTick();
    expect(queryEditorBookmarkLines(view)).toEqual([1]);
    Object.assign(props, { tabId: "bookmarks", modelValue: "one\ntwo\nthree", bookmarkLines: [3] });
    await nextTick();
    await nextTick();
    expect(queryEditorBookmarkLines(view)).toEqual([3]);
    expect(view.state.doc.toString()).toBe("one\ntwo\nthree");
  });

  it("tracks an external prepend without collapsing bookmarks at the document end", async () => {
    const { props } = await mountEditor("one\ntwo\nthree", { bookmarkLines: [2] });
    props.modelValue = "new\none\ntwo\nthree";
    await nextTick();
    expect(props.bookmarkLines).toEqual([3]);
  });

  it.each([
    { name: "insertion", before: "one\ntwo\nthree", after: "new\none\ntwo\nthree", saved: [2], expected: [3] },
    { name: "deletion", before: "one\ntwo\nthree", after: "two\nthree", saved: [3], expected: [2] },
  ])("persists mapped bookmarks after an inactive cached tab receives a line $name", async ({ before, after, saved, expected }) => {
    const { view, props, bookmarkChanges } = await mountEditor(before, { bookmarkLines: saved });
    await nextTick();
    Object.assign(props, { tabId: "other", modelValue: "other\nfile", bookmarkLines: [1] });
    await nextTick();
    await nextTick();
    bookmarkChanges.mockClear();

    // The stored lines still refer to the cached document, as with an external file reload.
    Object.assign(props, { tabId: "bookmarks", modelValue: after, bookmarkLines: saved });
    await nextTick();
    await nextTick();
    expect(queryEditorBookmarkLines(view)).toEqual(expected);
    expect(props.bookmarkLines).toEqual(expected);
    expect(bookmarkChanges).toHaveBeenLastCalledWith(expected, "bookmarks");
    expect(bookmarkChanges.mock.calls.every(([, owner]) => owner === "bookmarks")).toBe(true);

    const persisted = [...props.bookmarkLines!];
    const remounted = await mountEditor(after, { bookmarkLines: persisted });
    await nextTick();
    expect(queryEditorBookmarkLines(remounted.view)).toEqual(expected);
  });

  it("restores saved bookmarks when an empty cached tab hydrates while inactive", async () => {
    const { view, props } = await mountEditor("", { bookmarkLines: [3] });
    Object.assign(props, { tabId: "other", modelValue: "other", bookmarkLines: [1] });
    await nextTick();
    await nextTick();
    Object.assign(props, { tabId: "bookmarks", modelValue: "one\ntwo\nthree", bookmarkLines: [3] });
    await nextTick();
    await nextTick();
    expect(queryEditorBookmarkLines(view)).toEqual([3]);
    expect(props.bookmarkLines).toEqual([3]);
  });

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
