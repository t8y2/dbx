import { StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { buildInsertValueHints, insertValueHintsNeedTableColumns, parseInsertValuesClauses, type InsertValueHint } from "@/lib/sql/insertValueHints";

export const refreshInsertValueHintsEffect = StateEffect.define<null>();

export interface InsertValueHintsExtensionOptions {
  isEnabled?: () => boolean;
  /** Sync cache lookup for table columns when INSERT has no explicit column list. */
  getTableColumns?: (table: string, schema?: string) => string[] | undefined;
  /** Async loader invoked when sync cache misses; should call refresh after load. */
  requestTableColumns?: (table: string, schema?: string) => void;
}

class InsertValueHintWidget extends WidgetType {
  constructor(readonly column: string) {
    super();
  }

  eq(other: InsertValueHintWidget) {
    return other.column === this.column;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-insert-value-hint";
    span.textContent = this.column;
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

function decorationsForHints(hints: readonly InsertValueHint[]): DecorationSet {
  if (hints.length === 0) return Decoration.none;
  const ranges = hints
    .slice()
    .sort((a, b) => a.from - b.from || a.column.localeCompare(b.column))
    .map((hint) =>
      Decoration.widget({
        widget: new InsertValueHintWidget(hint.column),
        side: -1,
      }).range(hint.from),
    );
  return Decoration.set(ranges);
}

function buildHints(doc: string, options: InsertValueHintsExtensionOptions): InsertValueHint[] {
  const clauses = parseInsertValuesClauses(doc);
  for (const clause of clauses) {
    if (clause.columns !== null) continue;
    const cached = options.getTableColumns?.(clause.table, clause.schema);
    if (!cached) options.requestTableColumns?.(clause.table, clause.schema);
  }
  return buildInsertValueHints(clauses, {
    resolveTableColumns: (table, schema) => options.getTableColumns?.(table, schema),
  });
}

const insertValueHintsTheme = EditorView.baseTheme({
  ".cm-insert-value-hint": {
    display: "inline-block",
    marginRight: "0.35em",
    padding: "0 0.3em",
    borderRadius: "3px",
    fontSize: "0.85em",
    lineHeight: "1.2",
    verticalAlign: "baseline",
    color: "var(--cm-insert-value-hint-color, rgba(120, 120, 120, 0.95))",
    backgroundColor: "var(--cm-insert-value-hint-bg, rgba(120, 120, 120, 0.18))",
    pointerEvents: "none",
    userSelect: "none",
    fontStyle: "normal",
    fontWeight: "500",
  },
  "&dark .cm-insert-value-hint": {
    color: "var(--cm-insert-value-hint-color, rgba(180, 180, 180, 0.9))",
    backgroundColor: "var(--cm-insert-value-hint-bg, rgba(180, 180, 180, 0.16))",
  },
});

export function createInsertValueHintsExtension(options: InsertValueHintsExtensionOptions = {}): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private lastDoc = "";
      private lastEnabled = true;

      constructor(view: EditorView) {
        this.decorations = this.compute(view);
      }

      update(update: ViewUpdate) {
        const refreshed = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshInsertValueHintsEffect)));
        const enabled = options.isEnabled?.() ?? true;
        if (update.docChanged || refreshed || this.lastDoc !== update.state.doc.toString() || enabled !== this.lastEnabled) {
          this.decorations = this.compute(update.view);
        }
      }

      private compute(view: EditorView): DecorationSet {
        const enabled = options.isEnabled?.() ?? true;
        this.lastEnabled = enabled;
        if (!enabled) {
          this.lastDoc = view.state.doc.toString();
          return Decoration.none;
        }
        const doc = view.state.doc.toString();
        this.lastDoc = doc;
        return decorationsForHints(buildHints(doc, options));
      }
    },
    { decorations: (value) => value.decorations },
  );

  return [insertValueHintsTheme, plugin];
}

export function requestInsertValueHintsRefresh(view: EditorView) {
  view.dispatch({ effects: refreshInsertValueHintsEffect.of(null) });
}

export { insertValueHintsNeedTableColumns };
