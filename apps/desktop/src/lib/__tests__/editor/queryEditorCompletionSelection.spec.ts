// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { acceptCompletion, autocompletion, completionStatus, currentCompletions, moveCompletionSelection, selectedCompletionIndex, startCompletion } from "@codemirror/autocomplete";
import { EditorState, Prec, Transaction } from "@codemirror/state";
import { insertNewlineKeepIndent } from "@codemirror/commands";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { acceptSelectedCompletionWithRetry, acceptSelectedOrFirstCompletion } from "@/lib/editor/queryEditorCompletionAcceptance";

const queryEditorSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/editor/QueryEditor.vue"), "utf8");

function createCompletionView(doc = "", selectFirstCompletionOnOpen = false, interactionDelay: number | null = 0) {
  return new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        autocompletion({
          activateOnTyping: true,
          activateOnTypingDelay: 0,
          ...(interactionDelay === null ? {} : { interactionDelay }),
          selectOnOpen: selectFirstCompletionOnOpen,
          override: [() => ({ from: 0, options: [{ label: "select" }, { label: "set" }] })],
        }),
        Prec.highest(
          keymap.of([
            {
              key: "Tab",
              run: (view) => acceptSelectedOrFirstCompletion(view, acceptCompletion, selectedCompletionIndex, moveCompletionSelection(true)),
            },
            {
              key: "Enter",
              run: (view) => {
                if (selectFirstCompletionOnOpen) {
                  const result = acceptSelectedCompletionWithRetry(view, {
                    completionStatus,
                    acceptCompletion,
                    selectedCompletionIndex,
                    selectFirstCompletion: moveCompletionSelection(true),
                    retryDelayMs: 16,
                    maxWaitMs: 125,
                    onUnavailable: () => insertNewlineKeepIndent(view),
                  });
                  if (result.handled) return true;
                }
                return insertNewlineKeepIndent(view);
              },
            },
          ]),
        ),
      ],
    }),
  });
}

function press(view: EditorView, key: string): boolean {
  return runScopeHandlers(view, new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }), "editor");
}

async function expectCompletionOpenWithoutSelection(view: EditorView) {
  await expect.poll(() => completionStatus(view.state)).toBe("active");
  expect(currentCompletions(view.state).map((completion) => completion.label)).toEqual(["select", "set"]);
  expect(selectedCompletionIndex(view.state)).toBeNull();
}

describe("QueryEditor completion selection", () => {
  it("binds SQL completion to CodeMirror's unselected-on-open mode", () => {
    expect(queryEditorSource).toMatch(/selectOnOpen: settingsStore\.editorSettings\.selectFirstCompletionOnOpen/);
  });

  it("opens manual completion unselected and accepts the first option with Tab", async () => {
    const view = createCompletionView();

    expect(startCompletion(view)).toBe(true);
    await expectCompletionOpenWithoutSelection(view);
    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("select");
    view.destroy();
  });

  it("accepts an explicitly selected option instead of resetting to the first option", async () => {
    const view = createCompletionView();

    expect(startCompletion(view)).toBe(true);
    await expectCompletionOpenWithoutSelection(view);
    expect(press(view, "ArrowUp")).toBe(true);
    expect(selectedCompletionIndex(view.state)).toBe(1);
    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("set");
    view.destroy();
  });

  it("opens typing-triggered completion without selecting the first option", async () => {
    const view = createCompletionView();

    view.dispatch({
      changes: { from: 0, insert: "s" },
      selection: { anchor: 1 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    await expectCompletionOpenWithoutSelection(view);
    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("select");
    view.destroy();
  });

  it("keeps Enter as a newline while no completion option is selected", async () => {
    const view = createCompletionView();

    expect(startCompletion(view)).toBe(true);
    await expectCompletionOpenWithoutSelection(view);
    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("\n");
    view.destroy();
  });

  it("restores first-option selection and Enter acceptance when explicitly enabled", async () => {
    const view = createCompletionView("", true);

    expect(startCompletion(view)).toBe(true);
    await expect.poll(() => completionStatus(view.state)).toBe("active");
    expect(selectedCompletionIndex(view.state)).toBe(0);
    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("select");
    view.destroy();
  });

  it("waits through CodeMirror's default interaction delay before accepting Enter", async () => {
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const view = createCompletionView("", true, null);

    try {
      expect(startCompletion(view)).toBe(true);
      await expect.poll(() => completionStatus(view.state), { interval: 1 }).toBe("active");
      expect(selectedCompletionIndex(view.state)).toBe(0);
      expect(acceptCompletion(view)).toBe(false);
      expect(press(view, "Enter")).toBe(true);
      expect(view.state.doc.toString()).toBe("");

      now = 100;
      await expect.poll(() => view.state.doc.toString(), { interval: 10 }).toBe("select");
    } finally {
      dateNow.mockRestore();
      view.destroy();
    }
  });
});
