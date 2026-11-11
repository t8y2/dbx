// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { acceptCompletion, currentCompletions, hasNextSnippetField, hasPrevSnippetField, setSelectedCompletion, startCompletion } from "@codemirror/autocomplete";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";
import type { QueryEditorProps } from "../queryEditorTypes";
import { useSettingsStore } from "@/stores/settingsStore";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

async function mountEditor(overrides: Partial<QueryEditorProps> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  settings.editorSettings.showExecutionTargetPicker = false;
  settings.editorSettings.completionTriggerMode = "manual";
  const props = reactive<QueryEditorProps>({ modelValue: "", connectionId: "multi-cursor-snippet", databaseType: "mysql", dialect: "mysql", autoFocus: false, ...overrides });
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(QueryEditor, {
        ...props,
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
  return { view: EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!, settings, props };
}

function setSnippet(settings: ReturnType<typeof useSettingsStore>, body: string) {
  settings.editorSettings.snippets = [{ id: "multi-sf", prefix: "sf", label: "select from table", body }];
}

function cursorOffsets(lines: string[], prefixLength = 2): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset + prefixLength);
    offset += line.length + 1;
  }
  return offsets;
}

function setDocument(view: EditorView, lines: string[], mainIndex = 0) {
  const doc = lines.join("\n");
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc },
    selection: EditorSelection.create(
      cursorOffsets(lines).map((position) => EditorSelection.cursor(position)),
      mainIndex,
    ),
    annotations: isolateHistory.of("full"),
  });
}

async function acceptSnippet(view: EditorView) {
  startCompletion(view);
  await vi.waitFor(() => expect(currentCompletions(view.state).some((item) => item.type === "snippet")).toBe(true));
  const snippetIndex = currentCompletions(view.state).findIndex((item) => item.type === "snippet");
  view.dispatch({ effects: setSelectedCompletion(snippetIndex) });
  await vi.waitFor(() => expect(acceptCompletion(view)).toBe(true));
}

function selectedText(view: EditorView): string {
  return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
}

function press(view: EditorView, key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

function expandedLines(lines: string[], body: string): string[] {
  const template = body.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\{\d+\}/g, "");
  return lines.map((line) => `${template}${line.slice(2)}`);
}

function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function expectMainSelectionInside(view: EditorView, lines: string[], starts: number[], lineIndex: number, text: string) {
  expect(selectedText(view)).toBe(text);
  expect(view.state.selection.main.from).toBeGreaterThanOrEqual(starts[lineIndex]);
  expect(view.state.selection.main.to).toBeLessThanOrEqual(starts[lineIndex] + lines[lineIndex].length);
}

describe("QueryEditor multi-cursor snippets", () => {
  it("expands every rectangular cursor as one undoable edit", async () => {
    const { view, settings } = await mountEditor();
    setSnippet(settings, "select * from ${1:table_name};");
    const lines = ["sfhd_dwd.a", "sfhd_dwd.b", "sfhd_dwd.c"];
    const doc = lines.join("\n");
    const expected = expandedLines(lines, "select * from ${1:table_name};");
    setDocument(view, lines);
    await nextTick();

    await acceptSnippet(view);

    expect(view.state.doc.toString()).toBe(expected.join("\n"));
    expectMainSelectionInside(view, expected, lineStarts(expected), 0, "table_name");

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(expected.join("\n"));
  });

  it.each([
    [1, "second"],
    [2, "third"],
  ])("keeps the active snippet on the original main cursor (%s)", async (mainIndex) => {
    const { view, settings } = await mountEditor();
    setSnippet(settings, "select * from ${1:table_name};");
    const lines = ["sfhd_dwd.a", "sfhd_dwd.b", "sfhd_dwd.c"];
    const expected = expandedLines(lines, "select * from ${1:table_name};");
    setDocument(view, lines, mainIndex);
    await nextTick();

    await acceptSnippet(view);

    expect(view.state.doc.toString()).toBe(expected.join("\n"));
    expectMainSelectionInside(view, expected, lineStarts(expected), mainIndex, "table_name");
    expect(hasPrevSnippetField(view.state)).toBe(false);
    expect(hasNextSnippetField(view.state)).toBe(false);
  });

  it("leaves cursors without the typed prefix untouched but undoes the whole acceptance", async () => {
    const { view, settings } = await mountEditor();
    setSnippet(settings, "select * from ${1:table_name};");
    const lines = ["sfhd_dwd.a", "xxhd_dwd.b", "sfhd_dwd.c"];
    const doc = lines.join("\n");
    setDocument(view, lines);
    await nextTick();

    await acceptSnippet(view);

    expect(view.state.doc.toString()).toBe("select * from table_name;hd_dwd.a\nxxhd_dwd.b\nselect * from table_name;hd_dwd.c");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it.each([
    ["sfsf", 2, 4, 0, "xx", 0],
    ["sf sf", 2, 5, 1, "x x", 2],
  ])("does not swallow the adjacent cursor's expansion (%s, main %s)", async (doc, firstCursor, secondCursor, mainIndex, expected, expectedMainFrom) => {
    const { view, settings } = await mountEditor();
    setSnippet(settings, "${1:x}");
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      selection: EditorSelection.create([EditorSelection.cursor(firstCursor), EditorSelection.cursor(secondCursor)], mainIndex),
      annotations: isolateHistory.of("full"),
    });
    await nextTick();

    await acceptSnippet(view);

    expect(view.state.doc.toString()).toBe(expected);
    expect(selectedText(view)).toBe("x");
    expect(view.state.selection.main.from).toBe(expectedMainFrom);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(expected);
  });

  it("navigates the main cursor's snippet fields with Tab", async () => {
    const { view, settings } = await mountEditor();
    setSnippet(settings, "select ${1:col} from ${2:table_name};");
    const lines = ["sfhd_dwd.a", "sfhd_dwd.b", "sfhd_dwd.c"];
    const expected = expandedLines(lines, "select ${1:col} from ${2:table_name};");
    setDocument(view, lines, 1);
    await nextTick();

    await acceptSnippet(view);
    expect(view.state.doc.toString()).toBe(expected.join("\n"));
    expectMainSelectionInside(view, expected, lineStarts(expected), 1, "col");
    expect(hasNextSnippetField(view.state)).toBe(true);

    press(view, "Tab");
    expectMainSelectionInside(view, expected, lineStarts(expected), 1, "table_name");
  });
});
