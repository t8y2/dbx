import { StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { buildInsertValueHints, expandToSqlStatementWindow, insertValueHintsNeedTableColumns, parseInsertValuesClauses, type InsertValueHint, type InsertValuesClause, type TextRange } from "@/lib/sql/insertValueHints";

export const refreshInsertValueHintsEffect = StateEffect.define<null>();

/** Debounce hint reparse while the user is typing / holding a key. */
const INSERT_HINT_REPARSE_DELAY_MS = 80;

export interface InsertValueHintsExtensionOptions {
  isEnabled?: () => boolean;
  /** Sync cache lookup for table columns when INSERT has no explicit column list. */
  getTableColumns?: (table: string, schema?: string, database?: string) => string[] | undefined;
  /** Async loader invoked when sync cache misses; should call refresh after load. */
  requestTableColumns?: (table: string, schema?: string, database?: string) => void;
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
  const deduped: InsertValueHint[] = [];
  const seenFrom = new Set<number>();
  for (const hint of [...hints].sort((a, b) => a.from - b.from || a.column.localeCompare(b.column))) {
    if (seenFrom.has(hint.from)) continue;
    seenFrom.add(hint.from);
    deduped.push(hint);
  }
  const ranges = deduped.map((hint) =>
    Decoration.widget({
      widget: new InsertValueHintWidget(hint.column),
      side: -1,
    }).range(hint.from),
  );
  return Decoration.set(ranges);
}

function interestRanges(view: EditorView): TextRange[] {
  const ranges: TextRange[] = view.visibleRanges.map((range) => ({ from: range.from, to: range.to }));
  const cursor = view.state.selection.main.head;
  ranges.push({ from: cursor, to: cursor });
  return ranges;
}

function shiftClause(clause: InsertValuesClause, offset: number): InsertValuesClause {
  if (offset === 0) return clause;
  return {
    ...clause,
    span: { start: clause.span.start + offset, end: clause.span.end + offset },
    rows: clause.rows.map((row) => row.map((from) => from + offset)),
  };
}

/** Parse INSERT hints using only local slices around interest ranges — no full-document tokenize. */
function parseClausesNearView(view: EditorView): InsertValuesClause[] {
  const doc = view.state.doc;
  const clauses: InsertValuesClause[] = [];
  const seenStmtStarts = new Set<number>();

  for (const range of interestRanges(view)) {
    // Pull a bounded neighborhood from the doc instead of materializing the whole script.
    const pad = 32 * 1024;
    const sliceFrom = Math.max(0, range.from - pad);
    const sliceTo = Math.min(doc.length, range.to + pad);
    if (sliceTo <= sliceFrom) continue;
    const slice = doc.sliceString(sliceFrom, sliceTo);
    const window = expandToSqlStatementWindow(slice, range.from - sliceFrom, range.to - sliceFrom);
    if (window.to <= window.from) continue;
    const absStart = sliceFrom + window.from;
    if (seenStmtStarts.has(absStart)) continue;
    seenStmtStarts.add(absStart);
    const stmt = slice.slice(window.from, window.to);
    // Cheap reject: skip tokenize when the window clearly has no INSERT.
    if (!/\binsert\b/i.test(stmt)) continue;
    for (const clause of parseInsertValuesClauses(stmt)) {
      clauses.push(shiftClause(clause, absStart));
    }
  }
  return clauses;
}

function buildHints(view: EditorView, options: InsertValueHintsExtensionOptions): InsertValueHint[] {
  const clauses = parseClausesNearView(view);
  for (const clause of clauses) {
    if (clause.columns !== null) continue;
    const cached = options.getTableColumns?.(clause.table, clause.schema, clause.database);
    if (!cached) options.requestTableColumns?.(clause.table, clause.schema, clause.database);
  }
  return buildInsertValueHints(clauses, {
    resolveTableColumns: (table, schema, database) => options.getTableColumns?.(table, schema, database),
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
      private lastEnabled = true;
      private reparseTimer: ReturnType<typeof setTimeout> | null = null;

      constructor(view: EditorView) {
        this.decorations = this.compute(view);
      }

      update(update: ViewUpdate) {
        const refreshed = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshInsertValueHintsEffect)));
        const enabled = options.isEnabled?.() ?? true;

        if (!enabled) {
          this.clearTimer();
          this.lastEnabled = false;
          this.decorations = Decoration.none;
          return;
        }

        // Keep widget positions valid while a debounced reparse is pending.
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
        }

        if (refreshed || enabled !== this.lastEnabled) {
          this.clearTimer();
          this.lastEnabled = enabled;
          this.decorations = this.compute(update.view);
          return;
        }

        this.lastEnabled = enabled;
        if (update.docChanged || update.viewportChanged) {
          // Do not reparse on the hot path — key-repeat would block the UI.
          this.scheduleReparse(update.view);
        }
      }

      destroy() {
        this.clearTimer();
      }

      private scheduleReparse(view: EditorView) {
        this.clearTimer();
        this.reparseTimer = setTimeout(() => {
          this.reparseTimer = null;
          // Trigger a lightweight transaction so update() runs compute once typing pauses.
          view.dispatch({ effects: refreshInsertValueHintsEffect.of(null) });
        }, INSERT_HINT_REPARSE_DELAY_MS);
      }

      private clearTimer() {
        if (this.reparseTimer !== null) {
          clearTimeout(this.reparseTimer);
          this.reparseTimer = null;
        }
      }

      private compute(view: EditorView): DecorationSet {
        if (!(options.isEnabled?.() ?? true)) return Decoration.none;
        return decorationsForHints(buildHints(view, options));
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
