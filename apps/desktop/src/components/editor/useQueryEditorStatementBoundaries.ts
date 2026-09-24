import type { ShallowRef } from "vue";
import type { EditorView as EditorViewType, ViewPlugin as ViewPluginType } from "@codemirror/view";
import { executableStatementRangeCacheForDoc, statementGutterStartIndexForCache, mapStatementGutterStartIndex, type ExecutableStatementRangeCache, type StatementGutterStartIndex } from "@/lib/sql/executableStatementRangeCache";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";
import type { QueryEditorProps } from "./queryEditorTypes";
import type { QueryEditorCodeMirrorRuntime } from "./queryEditorCodeMirrorRuntime";

interface QueryEditorStatementBoundariesOptions {
  props: Readonly<QueryEditorProps>;
  view: ShallowRef<EditorViewType | null>;
  sqlStatementParameterOptions: () => SqlParameterOptions;
  cache: { value: ExecutableStatementRangeCache | null };
  runtime: QueryEditorCodeMirrorRuntime;
}

export function useQueryEditorStatementBoundaries(options: QueryEditorStatementBoundariesOptions) {
  const { props, view, sqlStatementParameterOptions, cache, runtime: codeMirrorRuntime } = options;
  // Lenient statement-boundary view shared by the run-statement gutter and the
  // current-statement frame. Re-parsing the whole document on every keystroke is
  // the dominant typing cost on large scripts, so while typing we only shift the
  // known start positions / frame range through the ChangeSet (O(statements)) and
  // rebuild exactly once after typing pauses. Paths that must stay exact (gutter
  // click-to-execute, execution picker) keep using the full on-demand parse.
  const STATEMENT_BOUNDARIES_REFRESH_MS = 150;

  let statementBoundariesView: {
    doc: import("@codemirror/state").Text;
    startsIndex: StatementGutterStartIndex;
    frameRange: { from: number; to: number } | null;
    fresh: boolean;
    generation: number;
  } | null = null;

  let statementBoundariesGeneration = 0;

  let statementBoundariesRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  function refreshStatementBoundaries(state: import("@codemirror/state").EditorState) {
    cache.value = executableStatementRangeCacheForDoc(cache.value, state.doc, props.databaseType, sqlStatementParameterOptions());
    statementBoundariesView = {
      doc: state.doc,
      startsIndex: statementGutterStartIndexForCache(cache.value),
      frameRange: null,
      fresh: true,
      generation: statementBoundariesGeneration,
    };
  }

  interface StatementBoundariesView {
    doc: import("@codemirror/state").Text;
    startsIndex: StatementGutterStartIndex;
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
        update(update: import("@codemirror/view").ViewUpdate) {
          if (!update.docChanged) return;
          const boundaries = statementBoundariesView;
          // No consumer (run gutter off + statement frame off) ever initialized
          // the view — nothing to maintain and no refresh to schedule.
          if (!boundaries) return;
          if (boundaries.doc === update.startState.doc) {
            statementBoundariesView = {
              doc: update.state.doc,
              startsIndex: mapStatementGutterStartIndex(boundaries.startsIndex, update.changes),
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
          if (statementBoundariesRefreshTimer !== null) {
            clearTimeout(statementBoundariesRefreshTimer);
            statementBoundariesRefreshTimer = null;
          }
        }
      },
    );
    return statementBoundariesTrackingPlugin;
  }
  return {
    statementBoundariesForState,
    createTrackingPlugin,
    invalidate() {
      statementBoundariesGeneration += 1;
    },
  };
}
