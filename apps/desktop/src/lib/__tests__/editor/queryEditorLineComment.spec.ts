// @vitest-environment happy-dom

import { toggleLineComment } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { EditorState, Prec, type Transaction } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { createQueryEditorLineCommentShortcutBindings, queryEditorCommentTokens, queryEditorLineCommentToken, queryEditorWordLanguageData } from "@/lib/editor/queryEditorLineComment";

function runToggleLineComment(doc: string, commentToken: string) {
  let state = EditorState.create({
    doc,
    selection: { anchor: 0 },
    extensions: [sql(), Prec.highest(EditorState.languageData.of(() => [{ commentTokens: { line: commentToken } }]))],
  });
  const dispatch = vi.fn((transaction: Transaction) => {
    state = transaction.state;
  });
  const handled = toggleLineComment({
    get state() {
      return state;
    },
    dispatch,
  } as never);

  return { handled, state };
}

describe("queryEditorLineCommentToken", () => {
  it("uses the MongoDB shell line comment marker", () => {
    expect(queryEditorLineCommentToken("mongodb")).toBe("//");
  });

  it("keeps block comment tokens while overriding MongoDB line comments", () => {
    expect(queryEditorCommentTokens("mongodb")).toEqual({
      line: "//",
      block: { open: "/*", close: "*/" },
    });
  });

  it("keeps the SQL line comment marker elsewhere", () => {
    expect(queryEditorLineCommentToken(undefined)).toBe("--");
    expect(queryEditorLineCommentToken("mysql")).toBe("--");
    expect(queryEditorLineCommentToken("postgres")).toBe("--");
  });
});

describe("QueryEditor word selection", () => {
  it("includes the @ prefix in SQL Server variable words", () => {
    const sqlServer = EditorState.create({ doc: "@name", extensions: [EditorState.languageData.of(() => queryEditorWordLanguageData("sqlserver"))] });
    const mysql = EditorState.create({ doc: "@name", extensions: [EditorState.languageData.of(() => queryEditorWordLanguageData("mysql"))] });
    const systemVariable = EditorState.create({ doc: "@@ROWCOUNT", extensions: [EditorState.languageData.of(() => queryEditorWordLanguageData("sqlserver"))] });

    for (let position = 0; position <= 5; position += 1) expect(sqlServer.wordAt(position)).toMatchObject({ from: 0, to: 5 });
    expect(mysql.wordAt(2)).toMatchObject({ from: 1, to: 5 });
    expect(systemVariable.wordAt(1)).toMatchObject({ from: 0, to: 10 });
  });

  it("includes the # prefix in SQL Server temp table words", () => {
    const create = (doc: string, dbType: "sqlserver" | "mysql") => EditorState.create({ doc, extensions: [EditorState.languageData.of(() => queryEditorWordLanguageData(dbType))] });
    const local = create("#order", "sqlserver");
    const global = create("##order", "sqlserver");
    const mysql = create("#order", "mysql");

    for (let position = 0; position <= 6; position += 1) expect(local.wordAt(position)).toMatchObject({ from: 0, to: 6 });
    for (let position = 0; position <= 7; position += 1) expect(global.wordAt(position)).toMatchObject({ from: 0, to: 7 });
    expect(mysql.wordAt(3)).toMatchObject({ from: 1, to: 6 });
  });
});

describe("QueryEditor line comment", () => {
  it("comments a MongoDB line with //", () => {
    const result = runToggleLineComment("db.users.find({})", "//");

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("// db.users.find({})");
  });

  it("uncomments a MongoDB line commented with //", () => {
    const result = runToggleLineComment("// db.users.find({})", "//");

    expect(result.state.doc.toString()).toBe("db.users.find({})");
  });

  it("still comments SQL with --", () => {
    const result = runToggleLineComment("SELECT 1", "--");

    expect(result.state.doc.toString()).toBe("-- SELECT 1");
  });
});

describe("createQueryEditorLineCommentShortcutBindings", () => {
  function createView(shortcut: string, run: (view: EditorView) => boolean, platform = "Win32") {
    return new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [keymap.of(createQueryEditorLineCommentShortcutBindings(shortcut, run, platform))],
      }),
    });
  }

  it.each([
    ["standard slash", { key: "/", code: "Slash", ctrlKey: true }],
    ["Chinese IME punctuation (、)", { key: "、", code: "Slash", ctrlKey: true }],
    ["IME Process key", { key: "Process", code: "Slash", ctrlKey: true }],
    ["IME Process key while isComposing", { key: "Process", code: "Slash", ctrlKey: true, isComposing: true }],
    ["numpad divide key (Divide)", { key: "Divide", code: "NumpadDivide", ctrlKey: true }],
    ["numpad divide key (/)", { key: "/", code: "NumpadDivide", ctrlKey: true }],
  ])("dispatches line comment for %s on Windows", (_name, eventInit) => {
    const run = vi.fn(() => true);
    const view = createView("Mod+/", run, "Win32");
    const event = new KeyboardEvent("keydown", {
      ...eventInit,
      bubbles: true,
      cancelable: true,
    });

    expect(runScopeHandlers(view, event, "editor")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(view);
    view.destroy();
  });

  it("leaves line comment unhandled when a different key is pressed", () => {
    const run = vi.fn(() => true);
    const view = createView("Mod+/", run, "Win32");
    const event = new KeyboardEvent("keydown", {
      key: "z",
      code: "KeyZ",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(runScopeHandlers(view, event, "editor")).toBe(false);
    expect(run).not.toHaveBeenCalled();
    view.destroy();
  });

  it("handles custom configured shortcut", () => {
    const run = vi.fn(() => true);
    const view = createView("Shift+Mod+C", run, "Win32");
    const event = new KeyboardEvent("keydown", {
      key: "C",
      code: "KeyC",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(runScopeHandlers(view, event, "editor")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    view.destroy();
  });

  it("keeps disabled when shortcut is empty", () => {
    expect(createQueryEditorLineCommentShortcutBindings("", vi.fn())).toEqual([]);
  });
});
