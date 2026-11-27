// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";
import { mySQL } from "@codemirror/legacy-modes/mode/sql";
import { describe, expect, it, vi } from "vitest";
import { createQueryEditorKeywordCaseOnTypeFilter, deferredKeywordReplacement, type PendingKeywordCase } from "@/lib/editor/queryEditorKeywordCaseOnType";
import type { SqlFormatterEngine } from "@/lib/sql/layout/internals";

// Controls the engine import timing so "typed before the preload resolved" is
// reproducible. The real engine is still used as the resolved value; only its
// availability is gated.
const gate = vi.hoisted(() => ({
  current: null as unknown,
  resolve: null as ((engine: unknown) => void) | null,
  promise: null as Promise<unknown> | null,
  loadReal: null as (() => Promise<unknown>) | null,
}));

vi.mock("@/lib/sql/layout/internals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sql/layout/internals")>();
  gate.loadReal = actual.loadEngine;
  gate.promise = new Promise((resolve) => {
    gate.resolve = resolve;
  });
  return {
    ...actual,
    loadedSqlFormatterEngine: () => gate.current,
    loadEngine: () => gate.promise,
  };
});

function createView(pendings: PendingKeywordCase[]) {
  return new EditorView({
    state: EditorState.create({
      doc: "select",
      selection: { anchor: 6 },
      // StreamLanguage leaves the filter without a readable Keyword tree, which
      // forces the deferred path while the engine is gated.
      extensions: [
        StreamLanguage.define(mySQL),
        EditorState.transactionFilter.of(
          createQueryEditorKeywordCaseOnTypeFilter({
            enabled: () => true,
            keywordCase: () => "upper",
            dialect: () => "mysql",
            databaseType: () => "mysql",
            onPending: (pending) => pendings.push(pending),
          }),
        ),
      ],
    }),
  });
}

describe("typing-time keyword case while the preload is still pending", () => {
  it("captures the word and converts it once the engine resolves", async () => {
    const realEngine = (await gate.loadReal!()) as SqlFormatterEngine | null;
    expect(realEngine).not.toBeNull();

    const pendings: PendingKeywordCase[] = [];
    const view = createView(pendings);

    view.dispatch({ ...view.state.replaceSelection(" "), userEvent: "input.type" });
    // No engine and no usable tree at this instant: the keyword is left alone…
    expect(view.state.doc.toString()).toBe("select ");
    // …but the trigger was captured for the moment the import resolves.
    expect(pendings).toHaveLength(1);
    expect(pendings[0]).toMatchObject({ word: "select", wordFrom: 0, wordEnd: 6 });

    gate.current = realEngine;
    gate.resolve!(realEngine);
    const replacement = deferredKeywordReplacement(view.state, pendings[0]!);
    expect(replacement).toEqual({ from: 0, to: 6, insert: "SELECT" });
    view.dispatch({ changes: replacement!, userEvent: "input.type" });
    expect(view.state.doc.toString()).toBe("SELECT ");
    view.destroy();
  });

  it("never rewrites when the document moved on", async () => {
    gate.current = (await gate.loadReal!()) as SqlFormatterEngine | null;
    const pending = { word: "select", wordFrom: 0, wordEnd: 6, dialect: "mysql", databaseType: "mysql", mode: "upper" } satisfies PendingKeywordCase;

    // The word grew into a longer identifier.
    expect(deferredKeywordReplacement(EditorState.create({ doc: "selectx " }), pending)).toBeNull();
    // The word was edited.
    expect(deferredKeywordReplacement(EditorState.create({ doc: "sele " }), pending)).toBeNull();
    // Still a keyword and untouched: converts.
    expect(deferredKeywordReplacement(EditorState.create({ doc: "select " }), pending)).toEqual({ from: 0, to: 6, insert: "SELECT" });
  });
});
