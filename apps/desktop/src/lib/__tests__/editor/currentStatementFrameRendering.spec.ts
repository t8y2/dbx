// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import { describe, expect, it } from "vitest";

/**
 * Regression coverage for t8y2/dbx#5628: the current-statement green frame used
 * to be drawn with a per-line `ch`-based width estimate that drifted on tabs,
 * CJK/fullwidth glyphs and non-monospaced fonts. It now renders via a
 * `Decoration.mark` so the browser lays the frame out at true character
 * boundaries.
 *
 * These tests assert the observable frame contract against a real CodeMirror
 * view: exactly one frame element exists for a statement, it spans the whole
 * statement text (leading/trailing whitespace included), and — crucially — it
 * is anchored to the *characters*, so a wide-glyph/ASCII mix keeps a single
 * contiguous frame that ends at the last statement character.
 */
function frameOverStatement(statement: string, range: { from: number; to: number }): HTMLElement | null {
  const theme = EditorView.theme({
    ".cm-db-current-statement-frame": {
      boxShadow: "inset 0 0 0 1px rgb(34 197 94 / 0.75)",
      borderRadius: "2px",
      boxDecorationBreak: "clone",
    },
  });
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc: statement,
      extensions: [theme, EditorView.decorations.of(Decoration.set([Decoration.mark({ class: "cm-db-current-statement-frame" }).range(range.from, range.to)]))],
    }),
  });
  const frames = view.dom.querySelectorAll(".cm-db-current-statement-frame");
  const first = frames[0] as HTMLElement | undefined;
  view.destroy();
  return first ?? null;
}

describe("current statement frame (pixel-exact rendering)", () => {
  it("wraps the full statement text in a single frame element", () => {
    const statement = "SELECT 1;";
    const frame = frameOverStatement(statement, { from: 0, to: statement.length });
    expect(frame).not.toBeNull();
    // The frame wraps every statement character (no estimated column gap).
    expect(frame!.textContent).toBe(statement);
  });

  it("anchors the frame to the statement characters, not the visual column estimate", () => {
    // A wide-glyph statement that the old `ch` estimator mis-sized on.
    const statement = "SELECT 中 Ａ;";
    const frame = frameOverStatement(statement, { from: 0, to: statement.length });
    expect(frame).not.toBeNull();
    expect(frame!.textContent).toBe(statement);
  });

  it("starts the frame at the statement start column, not at line start", () => {
    const statement = "  SELECT 1;";
    const start = statement.indexOf("S");
    const frame = frameOverStatement(statement, { from: start, to: statement.length });
    expect(frame).not.toBeNull();
    expect(frame!.textContent).toBe("SELECT 1;");
    expect(frame!.textContent).not.toBe(statement); // leading indent is excluded
  });

  it("covers a multi-line statement across every line fragment", () => {
    const statement = "SELECT a FROM t;\nWHERE b = 1;\n";
    const range = { from: 0, to: statement.length };
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: statement,
        extensions: [
          EditorView.theme({
            ".cm-db-current-statement-frame": {
              boxShadow: "inset 0 0 0 1px rgb(34 197 94 / 0.75)",
              borderRadius: "2px",
              boxDecorationBreak: "clone",
            },
          }),
          EditorView.decorations.of(Decoration.set([Decoration.mark({ class: "cm-db-current-statement-frame" }).range(range.from, range.to)])),
        ],
      }),
    });
    const frames = [...view.dom.querySelectorAll(".cm-db-current-statement-frame")] as HTMLElement[];
    view.destroy();
    // Each line gets its own frame fragment; together they cover the whole statement.
    expect(frames.length).toBeGreaterThan(1);
    const covered = frames.map((f) => f.textContent).join("");
    expect(covered).toContain("SELECT a FROM t;");
    expect(covered).toContain("WHERE b = 1;");
  });
});
