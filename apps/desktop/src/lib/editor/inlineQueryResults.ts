import { Facet, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { QueryResult } from "@/types/database";

export interface InlineQueryResult {
  from: number;
  to: number;
  result: QueryResult;
}
export const setInlineQueryResults = StateEffect.define<InlineQueryResult[]>();
/** Only attach a result when its recorded source still matches this document. */
export function inlineQueryResultSnapshots(sql: string, results: QueryResult[], previous: InlineQueryResult[] = []): InlineQueryResult[] {
  return results.flatMap((result) => {
    const existing = previous.find((item) => item.result === result || (result.sourceStatement && item.result.sourceStatement === result.sourceStatement && item.result.sourceFrom === result.sourceFrom && item.result.sourceTo === result.sourceTo));
    if (existing) return [{ ...existing, result }];
    const { sourceFrom: from, sourceTo: to, sourceStatement: statement } = result;
    if (!statement || from === undefined || to === undefined || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > sql.length || sql.slice(from, to).trim() !== statement.trim() || result.execution_error || !result.columns.length) return [];
    return [{ from, to, result }];
  });
}

export interface InlineResultHostLifecycle {
  mount(target: HTMLElement, result: QueryResult): void;
  unmount(target: HTMLElement, result: QueryResult): void;
  sync?(results: QueryResult[]): void;
}
class ResultWidget extends WidgetType {
  private resizeObserver?: ResizeObserver;
  constructor(
    readonly result: InlineQueryResult,
    readonly lifecycle: InlineResultHostLifecycle,
  ) {
    super();
  }
  eq(other: ResultWidget): boolean {
    return this.result.result === other.result.result && this.lifecycle === other.lifecycle;
  }
  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = "cm-inline-query-result";
    host.contentEditable = "false";
    // CodeMirror's content can grow to the widest SQL line. Keep the grid's
    // viewport bounded so its own horizontal scrollbar remains reachable.
    const resize = () => {
      const gutter = view.scrollDOM.querySelector(".cm-gutters")?.getBoundingClientRect().width ?? 0;
      const width = view.scrollDOM.clientWidth - gutter - 8;
      if (width > 0) host.style.width = `${width}px`;
    };
    resize();
    this.resizeObserver = new ResizeObserver(resize);
    this.resizeObserver.observe(view.scrollDOM);
    this.lifecycle.mount(host, this.result.result);
    return host;
  }
  destroy(host: HTMLElement) {
    this.resizeObserver?.disconnect();
    this.lifecycle.unmount(host, this.result.result);
  }
  ignoreEvent() {
    return true;
  }
}

const hostLifecycle = Facet.define<InlineResultHostLifecycle, InlineResultHostLifecycle>({ combine: (values) => values[0]! });
function decorations(state: EditorState, results: InlineQueryResult[]): DecorationSet {
  return Decoration.set(
    results.map((result) => Decoration.widget({ widget: new ResultWidget(result, state.facet(hostLifecycle)), block: true, side: 1 }).range(state.doc.lineAt(result.to).to)),
    true,
  );
}
const field = StateField.define<{ results: InlineQueryResult[]; decorations: DecorationSet }>({
  create: () => ({ results: [], decorations: Decoration.none }),
  update(value, transaction) {
    let results = value.results;
    if (transaction.docChanged) {
      results = results.flatMap((result) => {
        const from = transaction.changes.mapPos(result.from, -1);
        const to = transaction.changes.mapPos(result.to, 1);
        // An existing result remains the last executed snapshot while SQL
        // is edited. Only deleting its entire statement removes its host.
        return from === to ? [] : [{ ...result, from, to }];
      });
    }
    for (const effect of transaction.effects) {
      if (effect.is(setInlineQueryResults)) {
        results = effect.value.map((incoming) => results.find((existing) => existing.result === incoming.result) ?? incoming);
      }
    }
    if (results === value.results && !transaction.docChanged) return value;
    return { results, decorations: decorations(transaction.state, results) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});
export function currentInlineQueryResults(view: EditorView): InlineQueryResult[] {
  return view.state.field(field, false)?.results ?? [];
}
export function inlineQueryResultsExtension(lifecycle: InlineResultHostLifecycle) {
  return [
    hostLifecycle.of(lifecycle),
    field,
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(setInlineQueryResults)))) {
        lifecycle.sync?.(currentInlineQueryResults(update.view).map((item) => item.result));
      }
    }),
    EditorView.baseTheme({
      ".cm-inline-query-result": { height: "420px", minHeight: "180px", minWidth: "0", maxWidth: "100%", boxSizing: "border-box", margin: "6px 0", overflow: "hidden", resize: "vertical", whiteSpace: "normal", fontFamily: "system-ui", fontSize: "12px" },
    }),
  ];
}
