import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { createDeferredEditorTask } from "@/lib/editor/deferredEditorTask";

/** Absolute document range that must be rendered with the "unknown object" colour. */
export interface SqlUnknownObjectSpan {
  from: number;
  to: number;
}

export const setSqlUnknownObjectSpans = StateEffect.define<SqlUnknownObjectSpan[]>();
/**
 * Ask a mounted editor to re-run `load` immediately (used on tab activation,
 * where KeepAlive does not necessarily produce a focus or viewport change).
 */
export const refreshSqlUnknownObjectHighlights = StateEffect.define<null>();

export interface SqlUnknownObjectHighlightOptions {
  enabled: boolean;
  /** Resolves the ranges to colour. Called off the typing path, never per keystroke. */
  load: (view: EditorView) => Promise<SqlUnknownObjectSpan[]>;
  initialDelayMs: number;
  debounceMs: number;
}

const unknownObjectMark = Decoration.mark({
  class: "cm-sql-unknown-object",
  attributes: {
    "data-sql-token": "unknown",
  },
});

function buildDecorationSet(spans: readonly SqlUnknownObjectSpan[], docLength: number): DecorationSet {
  const normalized: SqlUnknownObjectSpan[] = [];
  const seen = new Set<string>();
  for (const span of spans) {
    const from = Math.max(0, Math.min(span.from, docLength));
    const to = Math.max(0, Math.min(span.to, docLength));
    if (to <= from) continue;
    const key = `${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ from, to });
  }
  // DecorationSet requires ranges in ascending order.
  normalized.sort((left, right) => left.from - right.from || left.to - right.to);
  return Decoration.set(
    normalized.map((span) => unknownObjectMark.range(span.from, span.to)),
    true,
  );
}

export function createSqlUnknownObjectHighlights(options: SqlUnknownObjectHighlightOptions): Extension {
  if (!options.enabled) return [];

  // Keeps the decorations as a DecorationSet so that typing shifts them through
  // the ChangeSet instead of clearing them until the next deferred scan lands.
  const spansField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, transaction) {
      for (const effect of transaction.effects) {
        if (effect.is(setSqlUnknownObjectSpans)) return buildDecorationSet(effect.value, transaction.state.doc.length);
      }
      if (transaction.docChanged) return decorations.map(transaction.changes);
      return decorations;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  const plugin = ViewPlugin.fromClass(
    class {
      private running = false;
      private view: EditorView;
      private readonly runTask: () => void;
      private readonly initialTask: ReturnType<typeof createDeferredEditorTask>;
      private readonly changeTask: ReturnType<typeof createDeferredEditorTask>;

      constructor(view: EditorView) {
        this.view = view;
        this.runTask = () => {
          void this.run();
        };
        this.initialTask = createDeferredEditorTask(this.runTask, options.initialDelayMs);
        this.changeTask = createDeferredEditorTask(this.runTask, options.debounceMs);
        this.initialTask.schedule();
      }

      update(update: ViewUpdate) {
        this.view = update.view;
        if (update.docChanged) {
          this.initialTask.cancel();
          this.changeTask.schedule();
          return;
        }
        if (update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshSqlUnknownObjectHighlights)))) {
          this.initialTask.cancel();
          this.changeTask.cancel();
          this.runTask();
        }
      }

      destroy() {
        this.initialTask.cancel();
        this.changeTask.cancel();
      }

      private async run() {
        if (this.running) return;
        const view = this.view;
        if (!view.dom.isConnected) return;
        const doc = view.state.doc;
        this.running = true;
        let spans: SqlUnknownObjectSpan[] = [];
        try {
          spans = await options.load(view);
        } catch {
          spans = [];
        } finally {
          this.running = false;
        }
        // A result computed against an older document (or a detached editor) is
        // stale: the next debounced run owns the current text.
        if (!view.dom.isConnected || view.state.doc !== doc) return;
        view.dispatch({ effects: setSqlUnknownObjectSpans.of(spans) });
      }
    },
  );

  return [
    spansField,
    plugin,
    EditorView.baseTheme({
      // The generated theme class prefixes this selector, and the table-name
      // colour is an `!important` rule at the same specificity, so the class is
      // repeated to win the cascade regardless of style-module injection order.
      ".cm-sql-unknown-object.cm-sql-unknown-object.cm-sql-unknown-object": {
        color: "var(--dbx-sql-unknown-object-color, #e5484d) !important",
      },
      ".cm-sql-unknown-object.cm-sql-unknown-object.cm-sql-unknown-object *": {
        color: "var(--dbx-sql-unknown-object-color, #e5484d) !important",
      },
    }),
  ];
}
