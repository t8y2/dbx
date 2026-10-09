import type { ShallowRef } from "vue";
import { RangeSet, RangeValue, type EditorState } from "@codemirror/state";
import type { EditorView as EditorViewType, ViewPlugin as ViewPluginType } from "@codemirror/view";
import { executableStatementRangeCacheForDoc, statementGutterStartIndexForCache, mapStatementGutterStartIndex, type ExecutableStatementRangeCache, type StatementGutterStartIndex } from "@/lib/sql/executableStatementRangeCache";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";
import type { QueryEditorProps } from "./queryEditorTypes";
import type { QueryEditorCodeMirrorRuntime } from "./queryEditorCodeMirrorRuntime";
import { createSqlStatementAnalysisWorker } from "@/lib/sql/sqlStatementAnalysisWorker";
import { shouldUseQueryEditorLargeDocumentModeForSize } from "@/lib/editor/queryEditorLargeDocument";
import type { FoldRange } from "@/lib/editor/codemirrorSqlBlockFolding";

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
    };
  }

  function ensureStatementCache(state: EditorState): Promise<ExecutableStatementRangeCache | null> {
    if (pendingAnalysis?.doc === state.doc && pendingAnalysis.generation === statementBoundariesGeneration) return pendingAnalysis.result;
    const generation = statementBoundariesGeneration;
    const result = analysisWorker.analyze({ sql: state.doc.toString(), databaseType: props.databaseType, parameterOptions: sqlStatementParameterOptions(), includeFolds: true, syntaxDialect: props.syntaxDialect ?? props.dialect, driverProfile: options.driverProfile?.() }).then((analysis) => {
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
      installStatementBoundaries(state, executableStatementRangeCacheForDoc(cache.value, state.doc, props.databaseType, sqlStatementParameterOptions()));
    }
  }

  interface StatementBoundariesView {
    doc: import("@codemirror/state").Text;
    startsIndex: StatementGutterStartIndex;
    folds: RangeSet<FoldRangeMarker>;
    frameRange: { from: number; to: number } | null;
    fresh: boolean;
    generation: number;
  }

  // Returns the view matching `state`, rebuilding it synchronously when the
  // tracked doc fell out of sync (first use, tab switch via setState) or the
  // dialect generation moved. While typing, the tracking plugin keeps the doc
  // reference current through ChangeSet mapping, so this stays cheap.
  function statementBoundariesForState(state: import("@codemirror/state").EditorState): StatementBoundariesView {
    if (statementBoundariesView && statementBoundariesView.doc === state.doc && statementBoundariesView.generation === statementBoundariesGeneration) return statementBoundariesView;
    statementBoundariesView = { doc: state.doc, startsIndex: { starts: RangeSet.empty, executableLineStarts: RangeSet.empty }, folds: RangeSet.empty, frameRange: null, fresh: false, generation: statementBoundariesGeneration };
    refreshStatementBoundaries(state);
    return statementBoundariesView!;
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
      let range: FoldRange | null = null;
      statementBoundariesForState(state).folds.between(lineEnd, lineEnd, (from, to) => {
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
