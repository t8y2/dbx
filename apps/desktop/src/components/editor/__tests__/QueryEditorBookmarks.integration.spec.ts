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
import { workspaceBookmarkCases } from "@/lib/editor/__tests__/workspaceBookmarkCases";
import { useQueryStore } from "@/stores/queryStore";
import WorkspaceBookmarksPanel from "@/components/layout/WorkspaceBookmarksPanel.vue";
import * as bookmarkMapping from "@/lib/editor/workspaceBookmarks";
import { insertNewline, deleteCharBackward, undo, redo, isolateHistory } from "@codemirror/commands";

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

async function mountWorkspace(before: string, saved: number[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().editorSettings.showExecutionTargetPicker = false;
  const store = useQueryStore();
  const first = store.openExternalSqlFile("", "", "/synthetic/first.sql", before);
  store.updateEditorBookmarks(first, saved);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render() {
      const tab = store.tabs.find((tab) => tab.id === store.activeTabId)!;
      return h("div", [
        h(QueryEditor, {
          tabId: tab.id,
          modelValue: tab.sql,
          bookmarkLines: tab.editorBookmarks,
          bookmarkDocument: tab.editorBookmarksDocument,
          databaseType: "mysql",
          dialect: "mysql",
          autoFocus: false,
          revealRequest: tab.editorRevealRequest,
          onBookmarksChange: (lines: number[], owner?: string) => store.updateEditorBookmarks(owner ?? tab.id, lines),
          "onUpdate:modelValue": (sql: string) => store.updateSql(tab.id, sql, "editor"),
          onEditorRevealConsumed: () => {
            tab.editorRevealRequest = undefined;
          },
        }),
        h(WorkspaceBookmarksPanel),
      ]);
    },
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
  await nextTick();
  const second = store.openExternalSqlFile("", "", "/synthetic/second.sql", "other\nfile");
  store.updateEditorBookmarks(second, [2]);
  await nextTick();
  await nextTick();
  return { store, first, second, host, view };
}

describe("QueryEditor line bookmarks", () => {
  it.each(["external", "store"])("keeps active %s reloads and subsequent editor edits in sync", async (path) => {
    const { store, first, view } = await mountWorkspace("a\nb\nc", [2]);
    store.switchTab(first);
    await nextTick();
    if (path === "store") store.updateSql(first, "new\na\nb\nc");
    else store.applyExternalSqlFileSnapshot(first, "new\na\nb\nc", { sizeBytes: 9, modifiedNs: "1", contentHash: "changed" });
    await nextTick();
    await nextTick();
    expect(queryEditorBookmarkLines(view)).toEqual([3]);
    view.dispatch({ changes: { from: 0, insert: "typed\n" } });
    await nextTick();
    const tab = store.tabs.find((tab) => tab.id === first)!;
    expect(tab.editorBookmarks).toEqual([4]);
    expect(tab.editorBookmarksDocument).toBe(tab.sql);
  });

  it.each(["external", "store"])("keeps successive inactive %s updates authoritative when the cached editor returns", async (path) => {
    const { store, first, host, view } = await mountWorkspace("a\nb\nc", [2]);
    const replace = (sql: string) => (path === "store" ? store.updateSql(first, sql) : store.applyExternalSqlFileSnapshot(first, sql, { sizeBytes: sql.length, modifiedNs: "1", contentHash: sql }));
    replace("a\nc");
    await nextTick();
    replace("new\na\nb\nc");
    await nextTick();
    const tab = store.tabs.find((tab) => tab.id === first)!;
    expect(tab.editorBookmarks).toEqual([4]); // deleted b mapped to c, which remains the anchor
    host.querySelector<HTMLButtonElement>(`[data-bookmark-tab="${first}"] [data-bookmark-line="4"]`)!.click();
    await nextTick();
    await nextTick();
    expect(queryEditorBookmarkLines(view)).toEqual([4]);
    expect(tab.editorBookmarks).toEqual([4]);
    expect(view.state.selection.main.head).toBe(view.state.doc.line(4).from);
  });

  it.each([{ name: "prepend", before: "a\nb\nc", after: "new\na\nb\nc", saved: [2], expected: [3] }, { name: "delete", before: "a\nb\nc", after: "b\nc", saved: [3], expected: [2] }, ...workspaceBookmarkCases].flatMap((test) => ["external", "store"].map((path) => ({ ...test, path }))))(
    "updates inactive store/panel positions before clicking a bookmark after $path $name",
    async ({ before, after, saved, expected, path }) => {
      const { store, first, second, host, view } = await mountWorkspace(before, saved);
      const tab = store.tabs.find((tab) => tab.id === first)!;
      if (path === "store") store.updateSql(first, after);
      else store.applyExternalSqlFileSnapshot(first, after, { sizeBytes: after.length, modifiedNs: "1", contentHash: "changed" });
      // The panel must already be correct, without first reactivating the editor.
      expect(store.activeTabId).toBe(second);
      expect(tab.editorBookmarks).toEqual(expected);
      await nextTick();
      expect(view.state.doc.toString()).toBe("other\nfile");
      const rows = [...host.querySelectorAll<HTMLButtonElement>(`[data-bookmark-tab="${first}"] [data-bookmark-line]`)];
      expect(rows.map((row) => Number(row.dataset.bookmarkLine))).toEqual(expected);
      for (const [index, row] of rows.entries()) expect(row.textContent).toContain(after.split("\n")[expected[index] - 1]);
      rows.at(-1)!.click();
      await nextTick();
      await nextTick();
      expect(store.activeTabId).toBe(first);
      expect(view.state.doc.toString()).toBe(after);
      expect(queryEditorBookmarkLines(view)).toEqual(expected);
      expect(tab.editorBookmarks).toEqual(expected); // no double mapping on activation
      expect(view.state.selection.main.head).toBe(view.state.doc.line(expected.at(-1)!).from);
      expect(store.tabs.find((tab) => tab.id === second)!.editorBookmarks).toEqual([2]);
      store.switchTab(second);
      await nextTick();
      store.switchTab(first);
      await nextTick();
      expect(queryEditorBookmarkLines(view)).toEqual(expected);
    },
  );

  it.each(["a\nb\nc", "repeat\nrepeat\nend"])("uses editor transaction markers for typing, Enter, Backspace, undo and redo without a second store diff: %s", async (sql) => {
    const { store, first, view, host } = await mountWorkspace(sql, [2]);
    store.switchTab(first);
    await nextTick();
    await nextTick();
    const mapping = vi.spyOn(bookmarkMapping, "mapPersistedBookmarks");
    const tab = store.tabs.find((tab) => tab.id === first)!;
    const assertLine = async (line: number) => {
      await nextTick();
      expect(tab.sql).toBe(view.state.doc.toString());
      expect(tab.editorBookmarks).toEqual([line]);
      expect(queryEditorBookmarkLines(view)).toEqual([line]);
      expect(tab.editorBookmarksDocument).toBe(tab.sql);
      expect(host.querySelector(`[data-bookmark-tab="${first}"] [data-bookmark-line="${line}"]`)?.textContent).toContain(sql.split("\n")[1]);
      expect(mapping).not.toHaveBeenCalled();
    };
    view.dispatch({ changes: { from: 0, insert: "typed" }, userEvent: "input.type", annotations: isolateHistory.of("full") });
    await assertLine(2);
    placeCursor(view, 0);
    expect(insertNewline(view)).toBe(true);
    await assertLine(3);
    expect(undo(view)).toBe(true);
    await assertLine(2);
    expect(redo(view)).toBe(true);
    await assertLine(3);
    placeCursor(view, 1);
    expect(deleteCharBackward(view)).toBe(true);
    await assertLine(2);
    store.switchTab(store.tabs.find((item) => item.id !== first)!.id);
    await nextTick();
    store.switchTab(first);
    await nextTick();
    await assertLine(2);
  });

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

  it.each([...workspaceBookmarkCases, { name: "insertion", before: "one\ntwo\nthree", after: "new\none\ntwo\nthree", saved: [2], expected: [3] }, { name: "deletion", before: "one\ntwo\nthree", after: "two\nthree", saved: [3], expected: [2] }])(
    "persists mapped bookmarks after an inactive cached tab receives a line $name",
    async ({ before, after, saved, expected }) => {
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
    },
  );

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
