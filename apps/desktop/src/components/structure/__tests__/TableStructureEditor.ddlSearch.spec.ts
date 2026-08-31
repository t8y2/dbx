// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { basicSetup } from "codemirror";
import { search as cmSearch } from "@codemirror/search";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectEditorSearchMatches, createEditorSearchQuery } from "@/lib/editor/editorSearchQuery";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      regexMaxMatchCount: 1000,
    },
  }),
}));

const ddl = `CREATE TABLE users (
  id BIGINT,
  username VARCHAR(255),
  email VARCHAR(255),
  created_at DATETIME
);`;
type SearchPanelHandle = {
  openSearch: () => boolean;
  closeSearch: () => boolean;
};

let editorHost: HTMLDivElement;
let panelHost: HTMLDivElement;
let editorView: EditorView;
let panelApp: App;
let panel: SearchPanelHandle;

beforeEach(async () => {
  editorHost = document.createElement("div");
  panelHost = document.createElement("div");
  document.body.append(editorHost, panelHost);

  let panelHandle: SearchPanelHandle | null = null;
  const state = EditorState.create({
    doc: ddl,
    extensions: [
      cmSearch({
        top: true,
        createPanel: () => {
          const dom = document.createElement("span");
          dom.style.display = "none";
          return { dom };
        },
      }),
      basicSetup,
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(true),
      Prec.highest(keymap.of([{ key: "Mod-f", run: () => panelHandle?.openSearch() ?? false, preventDefault: true }])),
    ],
  });
  editorView = new EditorView({ state, parent: editorHost });

  panelApp = createApp(EditorSearchPanel, { view: editorView });
  panel = panelApp.mount(panelHost) as unknown as SearchPanelHandle;
  panelHandle = panel;
  await nextTick();
});

afterEach(() => {
  panelApp.unmount();
  editorView.destroy();
  document.body.innerHTML = "";
});

function searchInput(): HTMLInputElement {
  const input = panelHost.querySelector<HTMLInputElement>(".editor-search-panel input");
  if (!input) throw new Error("Missing editor search input");
  return input;
}

function searchResultLabel(): HTMLElement {
  const label = panelHost.querySelector<HTMLElement>('[aria-live="polite"]');
  if (!label) throw new Error("Missing editor search result label");
  return label;
}

async function openSearchAndFind(text: string) {
  expect(panel.openSearch()).toBe(true);
  await nextTick();
  const input = searchInput();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(searchResultLabel().textContent).toContain("/2"));
  return input;
}

describe("TableStructureEditor DDL search", () => {
  it("routes Mod-f to the shared search panel and prevents browser find", async () => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "f",
    });

    editorView.contentDOM.dispatchEvent(event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(panelHost.querySelector(".editor-search-panel")).not.toBeNull();
  });

  it("finds both VARCHAR matches without changing the read-only DDL", async () => {
    const before = editorView.state.doc.toString();
    const input = await openSearchAndFind("VARCHAR");
    const query = createEditorSearchQuery({ search: "VARCHAR", caseSensitive: false, useRegex: false });

    expect(collectEditorSearchMatches(query, editorView.state, 0, editorView.state.doc.length)).toHaveLength(2);
    expect(searchResultLabel().textContent).toContain("/2");
    expect(editorView.state.doc.toString()).toBe(before);
    expect(editorView.state.facet(EditorState.readOnly)).toBe(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    await nextTick();
    expect(editorView.state.selection.main.from).toBe(ddl.lastIndexOf("VARCHAR"));
  });

  it("supports Escape and Ctrl+A in the DDL editor", async () => {
    const input = await openSearchAndFind("VARCHAR");
    const escape = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" });
    input.dispatchEvent(escape);
    await nextTick();
    expect(escape.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(panelHost.querySelector(".editor-search-panel")).toBeNull());

    const selectAll = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "a" });
    editorView.contentDOM.dispatchEvent(selectAll);
    expect(editorView.state.selection.main.from).toBe(0);
    expect(editorView.state.selection.main.to).toBe(editorView.state.doc.length);
  });
});
