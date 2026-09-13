// @vitest-environment happy-dom

import componentSource from "../QueryEditor.vue?raw";
import ts from "typescript";
import { indentMore } from "@codemirror/commands";
import { autocompletion, nextSnippetField, closeCompletion, completionKeymap, completionStatus, hasNextSnippetField, snippet, startCompletion, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, Prec } from "@codemirror/state";
import { getSearchQuery, SearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { createApp, h, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryEditorEscapeHandler } from "@/lib/editor/queryEditorEscape";
import EditorSearchPanel from "../EditorSearchPanel.vue";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { regexMaxMatchCount: 1000 } }) }));

const views: EditorView[] = [];
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

// Exercise the component's highest-priority Tab handler with real selections,
// including typing into each field before advancing to the next one.
const componentAst = ts.createSourceFile("QueryEditor.ts", componentSource.match(/^<script setup[^>]*>([\s\S]*?)<\/script>/m)![1], ts.ScriptTarget.Latest, true);
const tabFunctions = new Set(["handleTab", "tabKeyAcceptsCompletion", "handleTabWithoutAcceptingCompletion", "performNormalTab", "editorIndentUnit", "acceptCompletionOrNextSnippetField"]);
const tabSource = componentAst.statements
  .filter((statement) => ts.isFunctionDeclaration(statement) && statement.name && tabFunctions.has(statement.name.text))
  .map((statement) => statement.getText(componentAst))
  .join("\n");
const handleTab = new Function(
  "codeMirrorCompletionStatus",
  "codeMirrorNextSnippetField",
  "codeMirrorIndentMore",
  "settingsStore",
  "normalizeShortcutSettings",
  "shortcutToCodeMirrorKey",
  "isEditorComposing",
  "isBatchColumnSelectionCompletionActive",
  ts.transpileModule(tabSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + "\nreturn handleTab;",
)(
  completionStatus,
  nextSnippetField,
  indentMore,
  { editorSettings: { sqlFormatter: { useTabs: false, tabWidth: 2 }, shortcuts: { acceptCompletion: "Tab" } } },
  (value: unknown) => value,
  (value: unknown) => value,
  () => false,
  () => false,
) as (view: EditorView) => boolean;

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  for (const view of views.splice(0)) view.destroy();
});

function createEditor(pending = false, searchOpen = false) {
  let resolveCompletion: ((result: CompletionResult) => void) | undefined;
  let searchPanel: { openSearch: () => boolean; closeSearch: () => boolean };
  const closeSearch = vi.fn(() => searchPanel.closeSearch());
  const clearBatchSelection = vi.fn();
  const cancelPendingAcceptance = vi.fn();
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      extensions: [
        keymap.of(completionKeymap),
        autocompletion({
          defaultKeymap: false,
          activateOnTyping: false,
          override: [
            () =>
              pending
                ? new Promise<CompletionResult>((resolve) => {
                    resolveCompletion = resolve;
                  })
                : { from: 13, options: [{ label: "aaa" }] },
          ],
        }),
        Prec.highest(
          keymap.of([
            { key: "Tab", run: handleTab },
            { key: "Escape", run: createQueryEditorEscapeHandler({ closeSearch, clearBatchSelection, cancelPendingAcceptance, closeCompletion }) },
          ]),
        ),
      ],
    }),
  });
  views.push(view);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(EditorSearchPanel, {
        view,
        ref: (instance) => {
          searchPanel = instance as unknown as typeof searchPanel;
        },
      }),
  });
  app.mount(host);
  mountedApps.push({ app, host });
  snippet("CREATE TABLE ${table} (${column} ${type});")(view, { label: "create table" }, 0, 0);
  view.dispatch(view.state.replaceSelection("aa"));
  if (searchOpen) searchPanel!.openSearch();
  return { view, closeSearch, clearBatchSelection, cancelPendingAcceptance, isQueryRunning: () => !!resolveCompletion, resolveCompletion: () => resolveCompletion?.({ from: 13, options: [{ label: "aaa" }] }) };
}

function press(view: EditorView, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  return event.defaultPrevented;
}

function selectedText(view: EditorView) {
  return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
}

describe("QueryEditor Escape within snippet fields", () => {
  it.each([false, true])("does not mutate editor state when dismissing a hidden search panel (pending: %s)", async (pending) => {
    const { view, closeSearch, isQueryRunning } = createEditor(pending);
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe(pending ? "pending" : "active"));
    if (pending) await vi.waitFor(() => expect(isQueryRunning()).toBe(true));
    const before = view.state;
    const focus = vi.spyOn(view, "focus");

    expect(closeSearch()).toBe(false);
    expect(view.state).toBe(before);
    expect(focus).not.toHaveBeenCalled();
    expect(completionStatus(view.state)).toBe(pending ? "pending" : "active");
    expect(hasNextSnippetField(view.state)).toBe(true);
  });

  it.each([false, true])("dismisses completion and preserves both later Tab stops (pending: %s)", async (pending) => {
    const { view, clearBatchSelection, cancelPendingAcceptance, isQueryRunning, resolveCompletion } = createEditor(pending);
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe(pending ? "pending" : "active"));
    if (pending) await vi.waitFor(() => expect(isQueryRunning()).toBe(true));

    expect(press(view, "Escape")).toBe(true);
    expect(completionStatus(view.state)).toBeNull();
    expect(clearBatchSelection).toHaveBeenCalledOnce();
    expect(cancelPendingAcceptance).toHaveBeenCalledOnce();
    expect(hasNextSnippetField(view.state)).toBe(true);
    const doc = view.state.doc.toString();
    expect(press(view, "Tab")).toBe(true);
    expect(selectedText(view)).toBe("column");
    view.dispatch(view.state.replaceSelection("id"));
    expect(press(view, "Tab")).toBe(true);
    expect(selectedText(view)).toBe("type");
    expect(view.state.doc.toString()).toBe(doc.replace("column", "id"));

    resolveCompletion();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(completionStatus(view.state)).toBeNull();
    expect(selectedText(view)).toBe("type");
  });

  it("still exits the snippet when there is no completion", () => {
    const { view } = createEditor();
    expect(press(view, "Escape")).toBe(true);
    expect(hasNextSnippetField(view.state)).toBe(false);
  });

  it("allows a second Escape to exit the snippet after closing completion", async () => {
    const { view } = createEditor();
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    press(view, "Escape");
    expect(hasNextSnippetField(view.state)).toBe(true);
    press(view, "Escape");
    expect(hasNextSnippetField(view.state)).toBe(false);
  });

  it("preserves search dismissal priority", async () => {
    const { view, closeSearch } = createEditor(false, true);
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(press(view, "Escape")).toBe(true);
    expect(closeSearch).toHaveBeenCalledOnce();
    expect(completionStatus(view.state)).toBeNull();
    expect(hasNextSnippetField(view.state)).toBe(true);
  });

  it("still clears the query and collapses the selection when closing a visible search panel", () => {
    const { view, closeSearch } = createEditor(false, true);
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "aa" })), selection: { anchor: 13, head: 15 } });
    expect(closeSearch()).toBe(true);
    expect(getSearchQuery(view.state).search).toBe("");
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(15);
  });
});
