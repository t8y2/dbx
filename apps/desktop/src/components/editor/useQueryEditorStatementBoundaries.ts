import type { ShallowRef } from "vue";
import { EditorState, RangeSet, RangeValue } from "@codemirror/state";
import type { EditorView as EditorViewType, ViewPlugin as ViewPluginType } from "@codemirror/view";
import { queryEditorStatementDatabaseType } from "@/lib/mongo/mongoSql";
import { executableStatementRangeCacheForDoc, statementGutterStartIndexForCache, mapStatementGutterStartIndex, type ExecutableStatementRangeCache, type StatementGutterStartIndex } from "@/lib/sql/executableStatementRangeCache";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";
import type { QueryEditorProps } from "./queryEditorTypes";
import type { QueryEditorCodeMirrorRuntime } from "./queryEditorCodeMirrorRuntime";
import { createSqlStatementAnalysisWorker } from "@/lib/sql/sqlStatementAnalysisWorker";
import { shouldParseQueryEditorSyntax, shouldUseQueryEditorLargeDocumentModeForSize } from "@/lib/editor/queryEditorLargeDocument";
import { computeBlockFoldRanges, type FoldRange } from "@/lib/editor/codemirrorSqlBlockFolding";
import type { SqlTextRange } from "@/lib/sql/sqlStatementRanges";

/** Statements (sorted, non-overlapping) that intersect [from, to]. */
export function statementsOverlapping(ranges: readonly SqlTextRange[], from: number, to: number): SqlTextRange[] {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].to < from) low = middle + 1;
    else high = middle;
  }
  const found: SqlTextRange[] = [];
  for (let index = low; index < ranges.length && ranges[index].from <= to; index++) found.push(ranges[index]);
  return found;
}

class FoldRangeMarker extends RangeValue {
  startSide = 1;
  endSide = 1;
}

const foldRangeMarker = new FoldRangeMarker();

interface QueryEditorStatementBoundariesOptions {
  props: Readonly<QueryEditorProps>;
  view: ShallowRef<EditorViewType | null>;
  sqlStatementParameterOptions: () => SqlParameterOptions;
  cache: { value: ExecutableStatementRangeCache | null };
  runtime: QueryEditorCodeMirrorRuntime;
  driverProfile?: () => string | undefined;
  syntaxDialect?: () => QueryEditorProps["syntaxDialect"];
}

export function useQueryEditorStatementBoundaries(options: QueryEditorStatementBoundariesOptions) {
  const { props, view, sqlStatementParameterOptions, cache, runtime: codeMirrorRuntime } = options;
  // Lenient statement-boundary view shared by the run-statement gutter and the
  // current-statement frame. Re-parsing the whole document on every keystroke is
  // the dominant typing cost on large scripts, so while typing we only shift the
  // known positions through RangeSet mapping and rebuild after typing pauses,
  // off-thread for large documents. Paths that must stay exact (gutter
  // click-to-execute, execution picker) keep using the full on-demand parse.
  const STATEMENT_BOUNDARIES_REFRESH_MS = 150;
  // A single statement larger than this keeps no fold ranges: parsing it would cost more than the folding is worth.
  const WINDOW_FOLD_MAX_STATEMENT_LENGTH = 512 * 1024;
  const analysisWorker = createSqlStatementAnalysisWorker();
  let trackedView: EditorViewType | null = null;
  let pendingAnalysis: { doc: EditorState["doc"]; generation: number; result: Promise<ExecutableStatementRangeCache | null> } | null = null;

  let statementBoundariesView: {
    doc: import("@codemirror/state").Text;
    startsIndex: StatementGutterStartIndex;
    folds: RangeSet<FoldRangeMarker>;
    frameRange: { from: number; to: number } | null;
    fresh: boolean;
    generation: number;
    /** Statement starts whose fold ranges were already computed on demand (documents past the grammar budget). */
    windowFolded: Set<number>;
  } | null = null;

  let statementBoundariesGeneration = 0;

  let statementBoundariesRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelStatementBoundariesRefresh() {
    if (statementBoundariesRefreshTimer !== null) clearTimeout(statementBoundariesRefreshTimer);
    statementBoundariesRefreshTimer = null;
  }

  function clearStatementBoundaries() {
    cancelStatementBoundariesRefresh();
    analysisWorker.dispose();
    pendingAnalysis = null;
    statementBoundariesGeneration += 1;
    cache.value = null;
    statementBoundariesView = null;
  }

  function installStatementBoundaries(state: EditorState, result: ExecutableStatementRangeCache, folds?: Map<number, FoldRange>) {
    cache.value = result;
    statementBoundariesView = {
      doc: state.doc,
      startsIndex: statementGutterStartIndexForCache(result),
      folds: folds
        ? RangeSet.of(
            [...folds.values()].map((range) => foldRangeMarker.range(range.from, range.to)),
            true,
          )
        : RangeSet.empty,
      frameRange: null,
      fresh: true,
      generation: statementBoundariesGeneration,
      windowFolded: new Set(),
    };
  }

  function ensureStatementCache(state: EditorState): Promise<ExecutableStatementRangeCache | null> {
    if (pendingAnalysis?.doc === state.doc && pendingAnalysis.generation === statementBoundariesGeneration) return pendingAnalysis.result;
    const generation = statementBoundariesGeneration;
    const result = analysisWorker
      .analyze({
        sql: state.doc.toString(),
        databaseType: queryEditorStatementDatabaseType(props.databaseType, props.mongoQueryLanguage),
        parameterOptions: sqlStatementParameterOptions(),
        // Fold ranges need a full Lezer parse in the worker; past the grammar budget that costs ~100 bytes per character.
        includeFolds: shouldParseQueryEditorSyntax(state.doc.length),
        syntaxDialect: options.syntaxDialect?.() ?? props.syntaxDialect ?? props.dialect,
        driverProfile: options.driverProfile?.(),
      })
      .then((analysis) => {
        const currentView = view.value ?? trackedView;
        if (!analysis || generation !== statementBoundariesGeneration || currentView?.state.doc !== state.doc) return null;
        const resolved = { ...analysis, doc: state.doc };
        installStatementBoundaries(state, resolved, analysis.folds);
        const refreshEffect = codeMirrorRuntime.statementBoundariesRefreshEffect;
        if (refreshEffect) currentView.dispatch({ effects: refreshEffect.of(null) });
        return resolved;
      });
    pendingAnalysis = { doc: state.doc, generation, result };
    return result;
  }

  function refreshStatementBoundaries(state: EditorState) {
    if (shouldUseQueryEditorLargeDocumentModeForSize(state.doc.length, state.doc.lines)) {
      void ensureStatementCache(state);
    } else {
      installStatementBoundaries(state, executableStatementRangeCacheForDoc(cache.value, state.doc, queryEditorStatementDatabaseType(props.databaseType, props.mongoQueryLanguage), sqlStatementParameterOptions()));
    }
  }

  interface StatementBoundariesView {
    doc: import("@codemirror/state").Text;
    startsIndex: StatementGutterStartIndex;
    folds: RangeSet<FoldRangeMarker>;
    frameRange: { from: number; to: number } | null;
    fresh: boolean;
    generation: number;
    windowFolded: Set<number>;
  }

  // Returns the view matching `state`, rebuilding it synchronously when the
  // tracked doc fell out of sync (first use, tab switch via setState) or the
  // dialect generation moved. While typing, the tracking plugin keeps the doc
  // reference current through ChangeSet mapping, so this stays cheap.
  function statementBoundariesForState(state: import("@codemirror/state").EditorState): StatementBoundariesView {
    if (statementBoundariesView && statementBoundariesView.doc === state.doc && statementBoundariesView.generation === statementBoundariesGeneration) return statementBoundariesView;
    statementBoundariesView = { doc: state.doc, startsIndex: { starts: RangeSet.empty, executableLineStarts: RangeSet.empty }, folds: RangeSet.empty, frameRange: null, fresh: false, generation: statementBoundariesGeneration, windowFolded: new Set() };
    refreshStatementBoundaries(state);
    return statementBoundariesView!;
  }

  // Past the grammar budget the worker no longer parses the whole document for folds. Fold ranges are
  // computed here instead, one statement at a time and only for statements the fold gutter asks about
  // (the visible ones), so the cost follows the viewport rather than the document.
  function ensureWindowFolds(state: EditorState, boundaries: StatementBoundariesView, lineStart: number, lineEnd: number) {
    const parseWindowTree = codeMirrorRuntime.parseSqlWindowTree;
    const analysis = cache.value;
    if (!parseWindowTree || !boundaries.fresh || !analysis || analysis.doc !== state.doc) return;
    const databaseType = queryEditorStatementDatabaseType(props.databaseType, props.mongoQueryLanguage);
    const additions: Array<ReturnType<typeof foldRangeMarker.range>> = [];
    for (const statement of statementsOverlapping(analysis.ranges, lineStart, lineEnd)) {
      if (boundaries.windowFolded.has(statement.from)) continue;
      boundaries.windowFolded.add(statement.from);
      if (statement.to - statement.from > WINDOW_FOLD_MAX_STATEMENT_LENGTH) continue;
      const text = state.sliceDoc(statement.from, statement.to);
      const folds = computeBlockFoldRanges(EditorState.create({ doc: text }), databaseType, parseWindowTree(text));
      for (const range of folds.values()) additions.push(foldRangeMarker.range(statement.from + range.from, statement.from + range.to));
    }
    if (additions.length > 0) boundaries.folds = boundaries.folds.update({ add: additions, sort: true });
  }

  function scheduleStatementBoundariesRefresh(currentView: EditorViewType) {
    // True debounce: continuous typing must never pay a full-document parse —
    // mapped positions serve the gutter/frame, and one rebuild lands only after
    // the pause.
    if (statementBoundariesRefreshTimer !== null) clearTimeout(statementBoundariesRefreshTimer);
    statementBoundariesRefreshTimer = setTimeout(() => {
      statementBoundariesRefreshTimer = null;
      if (view.value !== currentView || !currentView.dom.isConnected) return;
      refreshStatementBoundaries(currentView.state);
      if (codeMirrorRuntime.statementBoundariesRefreshEffect) {
        currentView.dispatch({ effects: codeMirrorRuntime.statementBoundariesRefreshEffect.of(null) });
      }
    }, STATEMENT_BOUNDARIES_REFRESH_MS);
  }

  function createTrackingPlugin(ViewPlugin: typeof ViewPluginType) {
    const statementBoundariesTrackingPlugin = ViewPlugin.fromClass(
      class {
        constructor(currentView: EditorViewType) {
          trackedView = currentView;
        }

        update(update: import("@codemirror/view").ViewUpdate) {
          if (!update.docChanged) return;
          analysisWorker.cancel();
          pendingAnalysis = null;
          const boundaries = statementBoundariesView;
          // No consumer (run gutter off + statement frame off) ever initialized
          // the view — nothing to maintain and no refresh to schedule.
          if (!boundaries) return;
          if (boundaries.doc === update.startState.doc) {
            statementBoundariesView = {
              doc: update.state.doc,
              startsIndex: mapStatementGutterStartIndex(boundaries.startsIndex, update.changes),
              folds: boundaries.folds.map(update.changes),
              frameRange: boundaries.frameRange
                ? {
                    from: update.changes.mapPos(boundaries.frameRange.from, 1),
                    to: update.changes.mapPos(boundaries.frameRange.to, 1),
                  }
                : null,
              fresh: false,
              generation: boundaries.generation,
              windowFolded: new Set(),
            };
          }
          scheduleStatementBoundariesRefresh(update.view);
        }

        destroy() {
          clearStatementBoundaries();
          trackedView = null;
        }
      },
    );
    return statementBoundariesTrackingPlugin;
  }
  return {
    foldRangeForState(state: EditorState, lineStart: number): FoldRange | null | undefined {
      if (!shouldUseQueryEditorLargeDocumentModeForSize(state.doc.length, state.doc.lines)) return undefined;
      const lineEnd = state.doc.lineAt(lineStart).to;
      const boundaries = statementBoundariesForState(state);
      if (!shouldParseQueryEditorSyntax(state.doc.length)) ensureWindowFolds(state, boundaries, lineStart, lineEnd);
      let range: FoldRange | null = null;
      boundaries.folds.between(lineEnd, lineEnd, (from, to) => {
        if (from !== lineEnd) return;
        range = { from, to };
        return false;
      });
      return range;
    },
    statementBoundariesForState,
    createTrackingPlugin,
    ensureStatementCache,
    clear: clearStatementBoundaries,
    invalidate() {
      analysisWorker.cancel();
      pendingAnalysis = null;
      statementBoundariesGeneration += 1;
    },
  };
}
