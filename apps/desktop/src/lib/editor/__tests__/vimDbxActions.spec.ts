// @vitest-environment happy-dom

import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM, vim, Vim } from "@replit/codemirror-vim";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { configureVimDbxActions, DBX_VIM_ACTION_EVENT, type DbxVimActionDetail } from "../vimDbxActions";

const views: EditorView[] = [];
const sample = "SELECT 1;\nSELECT 2;\nSELECT 3;";
const unknown: string[] = [];

beforeAll(() => {
  configureVimDbxActions(Vim, { onUnknownAction: (name) => unknown.push(name) });
});

function editor(cursor = 0) {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: sample, selection: { anchor: cursor }, extensions: [Prec.highest(vim())] }) });
  views.push(view);
  const events: { detail: DbxVimActionDetail; selection: string }[] = [];
  view.contentDOM.addEventListener(DBX_VIM_ACTION_EVENT, (event) => {
    const sel = view.state.selection.main;
    events.push({ detail: (event as CustomEvent<DbxVimActionDetail>).detail, selection: view.state.sliceDoc(sel.from, sel.to) });
  });
  const cm = getCM(view)!;
  const keys = (...ks: string[]) => ks.forEach((k) => Vim.handleKey(cm, k, "user"));
  return { view, events, cm, keys };
}

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  unknown.length = 0;
});

describe(":dbx", () => {
  it("dispatches the action from an Ex command, case-insensitively", () => {
    const { cm, events } = editor();
    Vim.handleEx(cm, "dbx FORMATSQL extra");
    expect(events.map((e) => e.detail)).toEqual([{ action: "formatSql", args: ["extra"] }]);
  });

  it("reports unknown actions without dispatching", () => {
    const { cm, events } = editor();
    Vim.handleEx(cm, "dbx nope");
    Vim.handleEx(cm, "dbx");
    expect(events).toEqual([]);
    expect(unknown).toEqual(["nope", ""]);
  });

  it("runs through a vimrc-style normal-mode mapping", () => {
    const { cm, events, keys } = editor();
    Vim.handleEx(cm, "nnoremap Qr :DbxExecuteSql<CR>");
    keys("Q", "r");
    expect(events.map((e) => e.detail.action)).toEqual(["executeSql"]);
  });

  it("documents why a spaced rhs does not work in :map", () => {
    const { cm, events, keys } = editor();
    Vim.handleEx(cm, "nnoremap Qx :dbx formatSql<CR>");
    keys("Q", "x");
    expect(events).toEqual([]);
  });

  it("supports a <Space> leader once the default <Space> motion is unmapped", () => {
    const { cm, events, keys } = editor();
    Vim.handleEx(cm, "unmap <Space>");
    Vim.handleEx(cm, "nnoremap <Space>e :DbxExplainSql<CR>");
    keys("<Space>", "e");
    expect(events.map((e) => e.detail.action)).toEqual(["explainSql"]);
  });

  it("keeps a charwise visual selection for the action", () => {
    const { cm, events, keys } = editor(0);
    Vim.handleEx(cm, "vnoremap Qr :DbxExecuteSql<CR>");
    keys("v", "e", "Q", "r"); // select "SELECT"
    expect(events.map((e) => e.selection)).toEqual(["SELECT"]);
  });

  it("keeps a linewise visual selection for the action", () => {
    const { cm, events, keys } = editor(sample.indexOf("SELECT 2"));
    keys("V", "G");
    Vim.handleEx(cm, "'<,'>dbx executeSql");
    expect(events.map((e) => e.selection)).toEqual(["SELECT 2;\nSELECT 3;"]);
  });

  it("does not reuse an old visual selection for a plain :dbx", () => {
    const { cm, events, keys } = editor(0);
    keys("v", "e", "<Esc>");
    Vim.handleEx(cm, "dbx executeSql");
    expect(events.map((e) => e.selection)).toEqual([""]);
  });
});
