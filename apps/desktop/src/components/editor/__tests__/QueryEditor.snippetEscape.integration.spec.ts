// @vitest-environment happy-dom

import { createApp, h, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { completionStatus, hasNextSnippetField, hasPrevSnippetField, snippet, startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditor from "../QueryEditor.vue";

// Keep the real autocomplete state, keymaps, editor, and search child. Only
// replace SQL candidate retrieval so this regression needs no database.
vi.mock("@codemirror/autocomplete", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codemirror/autocomplete")>();
  return {
    ...actual,
    autocompletion: (config: Parameters<typeof actual.autocompletion>[0]) =>
      actual.autocompletion({
        ...config,
        override: [(context) => ({ from: context.pos, options: [{ label: "candidate" }] })],
      }),
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function mountEditor() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const state = reactive({ sql: "" });
  const host = document.createElement("div");
  document.body.append(host);
  const app: App = createApp({
    render: () =>
      h(QueryEditor, {
        modelValue: state.sql,
        tabId: "snippet-escape-integration",
        databaseType: "mysql",
        dialect: "mysql",
        autoFocus: false,
        "onUpdate:modelValue": (value: string) => {
          state.sql = value;
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
  return EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
}

function press(view: EditorView, key: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}
function selectedText(view: EditorView) {
  return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
}

describe("mounted QueryEditor snippet Escape", () => {
  it.each([false, true])("returns to the first field with Shift+Tab after Escape (second field edited: %s)", async (editSecondField) => {
    const view = await mountEditor();
    snippet("CREATE TABLE ${table} (${column} ${type});")(view, { label: "create table" }, 0, 0);
    view.dispatch(view.state.replaceSelection("demo"));
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    press(view, "Escape");
    press(view, "Tab");
    expect(selectedText(view)).toBe("column");
    if (editSecondField) view.dispatch(view.state.replaceSelection("id"));
    const beforeBack = view.state.doc.toString();
    expect(hasPrevSnippetField(view.state)).toBe(true);

    press(view, "Tab", true);
    expect(selectedText(view)).toBe("demo");
    expect(view.state.selection.main.from).toBe("CREATE TABLE ".length);
    expect(view.state.doc.toString()).toBe(beforeBack);
    expect(hasPrevSnippetField(view.state)).toBe(false);
    expect(hasNextSnippetField(view.state)).toBe(true);

    press(view, "Tab");
    expect(selectedText(view)).toBe(editSecondField ? "id" : "column");
    expect(view.state.doc.toString()).toBe(beforeBack);
  });

  it("navigates untouched fields with Tab, Shift+Tab, Tab without indenting", async () => {
    const view = await mountEditor();
    snippet("CREATE TABLE ${table} (${column} ${type});")(view, { label: "create table" }, 0, 0);
    const original = view.state.doc.toString();
    expect(selectedText(view)).toBe("table");
    press(view, "Tab");
    expect(selectedText(view)).toBe("column");
    press(view, "Tab", true);
    expect(selectedText(view)).toBe("table");
    press(view, "Tab");
    expect(selectedText(view)).toBe("column");
    press(view, "Tab");
    expect(selectedText(view)).toBe("type");
    expect(view.state.doc.toString()).toBe(original);
    expect(hasNextSnippetField(view.state)).toBe(false);
    expect(hasPrevSnippetField(view.state)).toBe(false);
  });

  it("still indents an ordinary selected range outside a snippet", async () => {
    const view = await mountEditor();
    const sql = "SELECT id\nFROM users;";
    view.dispatch({ changes: { from: 0, insert: sql }, selection: { anchor: 0, head: sql.length } });
    press(view, "Tab");
    expect(view.state.doc.toString()).toMatch(/^[ \t]+SELECT id\n[ \t]+FROM users;$/);
    expect(hasNextSnippetField(view.state)).toBe(false);
  });

  it("still accepts completion after typing into a snippet field", async () => {
    const view = await mountEditor();
    snippet("CREATE TABLE ${table} (${column} ${type});")(view, { label: "create table" }, 0, 0);
    view.dispatch(view.state.replaceSelection("demo"));
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    press(view, "Tab");
    await vi.waitFor(() => expect(view.state.doc.toString()).toContain("candidate"));
    expect(selectedText(view)).not.toBe("column");
  });

  it("dismisses completion through the real hidden search panel and keeps later fields", async () => {
    const view = await mountEditor();
    snippet("CREATE TABLE ${table} (${column} ${type});")(view, { label: "create table" }, 0, 0);
    view.dispatch(view.state.replaceSelection("demo"));
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));

    press(view, "Escape");
    expect(completionStatus(view.state)).toBeNull();
    expect(hasNextSnippetField(view.state)).toBe(true);
    press(view, "Tab");
    expect(selectedText(view)).toBe("column");
    view.dispatch(view.state.replaceSelection("id"));
    press(view, "Tab");
    expect(selectedText(view)).toBe("type");
    expect(view.state.doc.toString()).toBe("CREATE TABLE demo (id type);");
    // CodeMirror ends the snippet session on entry into its final field.
    expect(hasNextSnippetField(view.state)).toBe(false);
    expect(hasPrevSnippetField(view.state)).toBe(false);
  });
});
