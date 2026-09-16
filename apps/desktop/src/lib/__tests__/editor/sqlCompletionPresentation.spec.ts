// @vitest-environment happy-dom

import { acceptCompletion, autocompletion, completionStatus, currentCompletions, snippetCompletion, startCompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { compareSqlCompletions, completionLabelPresentation } from "@/lib/editor/sqlCompletionPresentation";

describe("SQL completion label presentation", () => {
  it("filters a custom snippet by trigger while preserving its display label", () => {
    expect(completionLabelPresentation("SELECT *", "ssf")).toEqual({
      label: "ssf SELECT *",
      displayLabel: "SELECT *",
      sortText: "SELECT *",
    });
  });

  it("leaves ordinary completion labels unchanged", () => {
    expect(completionLabelPresentation("SELECT")).toEqual({ label: "SELECT" });
    expect(completionLabelPresentation("select *", "sel")).toEqual({ label: "select *" });
  });

  it("keeps a differently named snippet visible and applicable in CodeMirror", async () => {
    const presentation = completionLabelPresentation("SELECT *", "ssf");
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: "ssf",
        selection: { anchor: 3 },
        extensions: [
          autocompletion({
            interactionDelay: 0,
            override: [() => ({ from: 0, options: [snippetCompletion("SELECT * FROM", { ...presentation, type: "snippet" })] })],
          }),
        ],
      }),
    });

    startCompletion(view);
    await expect.poll(() => completionStatus(view.state)).toBe("active");
    expect(currentCompletions(view.state)[0]).toMatchObject({ label: "ssf SELECT *", displayLabel: "SELECT *" });
    expect(acceptCompletion(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("SELECT * FROM");
    view.destroy();
  });
});

describe("SQL completion order", () => {
  it("keeps the current alphabetical tie-break by default", () => {
    const items = [
      { label: "id", type: "column" },
      { label: "z_last", type: "column" },
      { label: "a_first", type: "column" },
    ];

    expect([...items].sort((a, b) => compareSqlCompletions(a, b, true)).map((item) => item.label)).toEqual(["a_first", "id", "z_last"]);
  });

  it("preserves database order for column ties without changing their boosts", () => {
    const items = [
      { label: "id", type: "column", boost: 100 },
      { label: "z_last", type: "column", boost: 10 },
      { label: "a_first", type: "column", boost: 10 },
    ];

    expect([...items].sort((a, b) => compareSqlCompletions(a, b, false)).map((item) => item.label)).toEqual(["id", "z_last", "a_first"]);
    expect(items.map((item) => item.boost)).toEqual([100, 10, 10]);
  });

  it("keeps label ordering for non-columns and mixed item types", () => {
    expect(compareSqlCompletions({ label: "SELECT", type: "keyword" }, { label: "FROM", type: "keyword" }, false)).toBeGreaterThan(0);
    expect(compareSqlCompletions({ label: "z_column", type: "column" }, { label: "a_table", type: "table" }, false)).toBeGreaterThan(0);
    expect(compareSqlCompletions({ label: "visible", sortText: "a_sort", type: "snippet" }, { label: "before", type: "keyword" }, false)).toBeLessThan(0);
  });

  it("preserves database order in CodeMirror when column match scores tie", async () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [
          autocompletion({
            interactionDelay: 0,
            compareCompletions: (a, b) => compareSqlCompletions(a, b, false),
            override: [
              () => ({
                from: 0,
                options: [
                  { label: "id", type: "column", boost: 100 },
                  { label: "z_last", type: "column", boost: 10 },
                  { label: "a_first", type: "column", boost: 10 },
                ],
              }),
            ],
          }),
        ],
      }),
    });

    startCompletion(view);
    await expect.poll(() => completionStatus(view.state)).toBe("active");
    expect(currentCompletions(view.state).map((item) => item.label)).toEqual(["id", "z_last", "a_first"]);
    view.destroy();
  });

  it("keeps the default CodeMirror alphabetical tie-break and key priority", async () => {
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        extensions: [
          autocompletion({
            interactionDelay: 0,
            compareCompletions: (a, b) => compareSqlCompletions(a, b, true),
            override: [
              () => ({
                from: 0,
                options: [
                  { label: "id", type: "column", boost: 100 },
                  { label: "z_last", type: "column", boost: 10 },
                  { label: "a_first", type: "column", boost: 10 },
                ],
              }),
            ],
          }),
        ],
      }),
    });

    startCompletion(view);
    await expect.poll(() => completionStatus(view.state)).toBe("active");
    expect(currentCompletions(view.state).map((item) => item.label)).toEqual(["id", "a_first", "z_last"]);
    view.destroy();
  });
});
