// @vitest-environment happy-dom

import { acceptCompletion, autocompletion, completionStatus, currentCompletions, snippetCompletion, startCompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { completionLabelPresentation } from "@/lib/editor/sqlCompletionPresentation";

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
