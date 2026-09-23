import type { CompletionContext } from "@codemirror/autocomplete";
import { type QueryCompletionOption } from "./useQueryEditorBatchSelection";
import { type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import { executableStatementRangeCacheForDoc, statementGutterStartIndexHasStartAt } from "@/lib/sql/executableStatementRangeCache";
import { createDeferredEditorTask } from "@/lib/editor/deferredEditorTask";
import { currentStatementFrameRangeTo } from "@/lib/sql/currentStatementFrame";
import { expandToSqlStatementWindow } from "@/lib/sql/insertValueHints";
import { createSqlSignatureTooltipDom } from "@/lib/editor/sqlSignatureTooltip";
import { getSqlFunctionSignatureHelp } from "@/lib/sql/sqlCompletion";
import { shellLineCommentTheme, sqlSemanticHighlightTheme } from "@/lib/editor/editorThemes";
import { createStatementGutterMarkerDom } from "@/lib/editor/codemirrorStatementGutter";
import { compareSqlCompletions } from "@/lib/editor/sqlCompletionPresentation";
import { currentStatementFrameLayer } from "@/lib/editor/codemirrorCurrentStatementFrameLayer";
import { createSqlAliasHighlights } from "@/lib/editor/codemirrorSqlAliasHighlights";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { sqlSemanticTableNameSpansForSyntaxTree } from "@/lib/editor/codemirrorSqlSemanticHighlight";
import { queryEditorCommentTokens, queryEditorLineCommentToken, queryEditorWordLanguageData } from "@/lib/editor/queryEditorLineComment";
import { createShellLineCommentHighlight } from "@/lib/editor/codemirrorShellLineCommentHighlight";
import type { StatementExecutionMarker } from "@/lib/tabs/tabPresentation";
import { resolveSqlDialectId } from "@/lib/sql/semantic/dialect";
import type { DatabaseType } from "@/types/database";
import type { ComputedRef } from "vue";
import type { EditorView as EditorViewType } from "@codemirror/view";
import type { Composer } from "vue-i18n";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { QueryEditorProps } from "./queryEditorTypes";
import type { QueryEditorCodeMirrorRuntime, QueryEditorCodeMirrorModules } from "./queryEditorCodeMirrorRuntime";
import type { useQueryEditorDiagnostics } from "./useQueryEditorDiagnostics";
import type { useQueryEditorCompletion } from "./useQueryEditorCompletion";
import type { useQueryEditorBatchSelection } from "./useQueryEditorBatchSelection";
import type { useQueryEditorStatementBoundaries } from "./useQueryEditorStatementBoundaries";
import type { ExecutableStatementRangeCache } from "@/lib/sql/executableStatementRangeCache";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";

interface QueryEditorSqlExtensionsOptions {
  props: Readonly<QueryEditorProps>;
  runtime: QueryEditorCodeMirrorRuntime;
  modules: QueryEditorCodeMirrorModules;
  settingsStore: ReturnType<typeof useSettingsStore>;
  t: Composer["t"];
  sqlBehaviorDialect: () => QueryEditorProps["dialect"];
  sqlDriverProfile: ComputedRef<string | undefined>;
  sqlStatementParameterOptions: () => SqlParameterOptions;
  queryEditorSelectionLanguage: () => "sql" | "text";
  cache: { value: ExecutableStatementRangeCache | null };
  completion: ReturnType<typeof useQueryEditorCompletion>;
  batchSelection: ReturnType<typeof useQueryEditorBatchSelection>;
  diagnostics: Pick<ReturnType<typeof useQueryEditorDiagnostics>, "sqlErrorDecorationRange" | "sqlSemanticDecorationRanges">;
  statementBoundaries: ReturnType<typeof useQueryEditorStatementBoundaries>;
  currentExecutableStatementRange: (view: EditorViewType) => SqlTextRange | null;
  executeSqlStatementFromGutter: (view: EditorViewType, line: { from: number; to: number }, event: Event) => boolean;
  signatureHelpWindowChars: number;
}

export function configureQueryEditorSqlExtensions(options: QueryEditorSqlExtensionsOptions) {
  const { props, runtime: codeMirrorRuntime, settingsStore, t, sqlBehaviorDialect, sqlDriverProfile, sqlStatementParameterOptions, queryEditorSelectionLanguage, cache, batchSelection, currentExecutableStatementRange, executeSqlStatementFromGutter } = options;
  const { EditorView, Decoration, StateField, StateEffect, GutterMarker, RangeSet, lineNumberMarkers, gutter, showTooltip, autocompletion, ViewPlugin, highlightingFor, syntaxTree, langSql, Prec, EditorState, ensureSyntaxTree, layer, RectangleMarker } = options.modules;
  const { provideSqlCompletions } = options.completion;
  const { renderBatchColumnSelectionActionMarker, renderBatchColumnSelectionCheckbox } = batchSelection;
  const { sqlErrorDecorationRange, sqlSemanticDecorationRanges } = options.diagnostics;
  const { statementBoundariesForState } = options.statementBoundaries;
  const SQL_SIGNATURE_HELP_WINDOW_CHARS = options.signatureHelpWindowChars;

  const diagnosticTheme = EditorView.baseTheme({
    ".cm-sql-error": {
      textDecoration: "underline wavy var(--dbx-editor-diagnostic-error, var(--destructive))",
      textUnderlineOffset: "3px",
    },
    ".cm-sql-semantic-warning": {
      textDecoration: "underline wavy var(--dbx-editor-diagnostic-warning, var(--warning))",
      textUnderlineOffset: "3px",
    },
  });

  codeMirrorRuntime.buildSqlDiagnosticExtension = () => {
    const diagnosticEffect = codeMirrorRuntime.setSqlDiagnosticsEffect;
    const buildDecorations = (state: import("@codemirror/state").EditorState) => {
      const errorDecorations = sqlErrorDecorationRange(state).map((range) =>
        Decoration.mark({
          class: "cm-sql-error",
          attributes: { title: range.message },
        }).range(range.from, range.to),
      );
      const semanticDecorations = sqlSemanticDecorationRanges(state).map((range) =>
        Decoration.mark({
          class: range.severity === "error" ? "cm-sql-error" : "cm-sql-semantic-warning",
          attributes: { title: range.message },
        }).range(range.from, range.to),
      );
      return Decoration.set([...errorDecorations, ...semanticDecorations], true);
    };

    const field = StateField.define({
      create: buildDecorations,
      update(value, transaction) {
        const diagnosticsChanged = !!diagnosticEffect && transaction.effects.some((effect) => effect.is(diagnosticEffect));
        if (diagnosticsChanged) return buildDecorations(transaction.state);
        if (transaction.docChanged) return Decoration.set([]);
        return value;
      },
      provide: (field) => EditorView.decorations.from(field),
    });

    return [field, diagnosticTheme];
  };

  codeMirrorRuntime.setPreviewRangeEffect = StateEffect.define<{
    from: number;
    to: number;
  } | null>();

  codeMirrorRuntime.buildPreviewRangeExtension = () => {
    const effectType = codeMirrorRuntime.setPreviewRangeEffect!;
    const field = StateField.define({
      create() {
        return Decoration.none;
      },
      update(decorations, transaction) {
        for (const effect of transaction.effects) {
          if (effect.is(effectType)) {
            const range = effect.value;
            if (!range) return Decoration.none;
            return Decoration.set([Decoration.mark({ class: "cm-db-execution-preview" }).range(range.from, range.to)]);
          }
        }
        if (transaction.docChanged || transaction.selection) return Decoration.none;
        return decorations;
      },
      provide: (f) => EditorView.decorations.from(f),
    });
    return field;
  };

  class ResultSourceLineNumberMarker extends GutterMarker {
    elementClass = "cm-db-result-source-line-number";
  }

  const resultSourceLineNumberMarker = new ResultSourceLineNumberMarker();

  codeMirrorRuntime.setResultSourceRangeEffect = StateEffect.define<{
    from: number;
    to: number;
  } | null>();

  codeMirrorRuntime.buildResultSourceRangeExtension = () => {
    const effectType = codeMirrorRuntime.setResultSourceRangeEffect!;
    const markersForRange = (state: import("@codemirror/state").EditorState, range: { from: number; to: number }) => {
      const from = Math.max(0, Math.min(range.from, state.doc.length));
      const to = Math.max(from, Math.min(range.to, state.doc.length));
      const startLine = state.doc.lineAt(from);
      const endLine = state.doc.lineAt(Math.max(from, to - 1));
      const markers = Array.from({ length: endLine.number - startLine.number + 1 }, (_, index) => resultSourceLineNumberMarker.range(state.doc.line(startLine.number + index).from));
      return RangeSet.of(markers);
    };

    const field = StateField.define({
      create() {
        return RangeSet.empty;
      },
      update(markers, transaction) {
        for (const effect of transaction.effects) {
          if (effect.is(effectType)) {
            return effect.value ? markersForRange(transaction.state, effect.value) : RangeSet.empty;
          }
        }
        if (transaction.docChanged || transaction.selection) return RangeSet.empty;
        return markers;
      },
      provide: (field) => lineNumberMarkers.from(field),
    });

    const highlightField = StateField.define({
      create() {
        return Decoration.none;
      },
      update(decorations, transaction) {
        for (const effect of transaction.effects) {
          if (effect.is(effectType)) {
            const range = effect.value;
            if (!range) return Decoration.none;
            const from = Math.max(0, Math.min(range.from, transaction.state.doc.length));
            const to = Math.max(from, Math.min(range.to, transaction.state.doc.length));
            return from === to ? Decoration.none : Decoration.set([Decoration.mark({ class: "cm-db-result-source-highlight" }).range(from, to)]);
          }
        }
        if (transaction.docChanged || transaction.selection) return Decoration.none;
        return decorations;
      },
      provide: (field) => EditorView.decorations.from(field),
    });
    return [field, highlightField];
  };

  class StatementExecutionStateMarker extends GutterMarker {
    constructor(readonly marker: StatementExecutionMarker) {
      super();
    }

    eq(other: import("@codemirror/view").GutterMarker): boolean {
      return other instanceof StatementExecutionStateMarker && other.marker.status === this.marker.status && other.marker.successCount === this.marker.successCount && other.marker.errorCount === this.marker.errorCount && other.marker.runningCount === this.marker.runningCount;
    }
  }

  class StatementGutterMarker extends GutterMarker {
    constructor(
      readonly canExecute: boolean,
      readonly marker?: StatementExecutionMarker,
    ) {
      super();
    }

    eq(other: import("@codemirror/view").GutterMarker): boolean {
      return (
        other instanceof StatementGutterMarker &&
        other.canExecute === this.canExecute &&
        other.marker?.status === this.marker?.status &&
        other.marker?.successCount === this.marker?.successCount &&
        other.marker?.errorCount === this.marker?.errorCount &&
        other.marker?.runningCount === this.marker?.runningCount
      );
    }

    toDOM() {
      return createStatementGutterMarkerDom({
        canExecute: this.canExecute,
        executeLabel: t("editor.contextMenu.executeCurrent"),
        status: this.marker?.status,
        statusLabel: this.marker ? statementExecutionMarkerTitle(this.marker) : undefined,
      });
    }
  }

  function statementExecutionMarkerTitle(marker: StatementExecutionMarker) {
    const parts = [];
    if ((marker.runningCount ?? 0) > 0) parts.push(t("editor.statementExecutionRunning", { count: marker.runningCount }));
    if (marker.successCount > 0) parts.push(t("editor.statementExecutionSucceeded", { count: marker.successCount }));
    if (marker.errorCount > 0) parts.push(t("editor.statementExecutionFailed", { count: marker.errorCount }));
    return parts.join(", ");
  }

  codeMirrorRuntime.setStatementExecutionMarkersEffect = StateEffect.define<StatementExecutionMarker[]>();

  codeMirrorRuntime.buildRunStatementGutterExtension = () => {
    const effectType = codeMirrorRuntime.setStatementExecutionMarkersEffect!;
    const showRunButtons = !props.hideExecutionControls && settingsStore.editorSettings.showStatementRunButtons;
    const markersForState = (state: import("@codemirror/state").EditorState, markers: readonly StatementExecutionMarker[]) => {
      const ranges = markers.map((marker) => {
        const from = Math.max(0, Math.min(marker.from, state.doc.length));
        return new StatementExecutionStateMarker(marker).range(state.doc.lineAt(from).from);
      });
      return RangeSet.of(ranges, true);
    };

    const field = StateField.define({
      create(state) {
        return markersForState(state, props.statementExecutionMarkers ?? []);
      },
      update(markers, transaction) {
        for (const effect of transaction.effects) {
          if (effect.is(effectType)) return markersForState(transaction.state, effect.value);
        }
        if (transaction.docChanged) return RangeSet.empty;
        return markers;
      },
      provide: (field) =>
        gutter({
          class: "cm-run-statement-gutter",
          markers: (currentView) => currentView.state.field(field),
          lineMarker(currentView, line, markers) {
            const executionMarker = markers.find((marker) => marker instanceof StatementExecutionStateMarker)?.marker;
            // Membership check against the lenient index (mapped through the
            // ChangeSet while typing) instead of a full-document re-parse per
            // keystroke. The click handler still resolves the exact range on
            // demand, so display-level approximation never affects execution.
            const canExecute = showRunButtons && statementGutterStartIndexHasStartAt(statementBoundariesForState(currentView.state).startsIndex, line.from);
            return canExecute || executionMarker ? new StatementGutterMarker(canExecute, executionMarker) : null;
          },
          lineMarkerChange(update) {
            // Redraw once the debounced full rebuild has landed.
            const refreshEffect = codeMirrorRuntime.statementBoundariesRefreshEffect;
            return !!refreshEffect && update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshEffect)));
          },
          domEventHandlers: showRunButtons
            ? {
                mousedown: executeSqlStatementFromGutter,
              }
            : {},
        }),
    });
    return field;
  };

  codeMirrorRuntime.buildSqlSignatureExtension = () =>
    showTooltip.compute(["doc", "selection"], (currentState) => {
      const cursor = currentState.selection.main.head;
      // Signature detection only scans backward from the cursor, so window the
      // text instead of materializing the whole document prefix on every
      // keystroke — doc.toString() was O(document) per key on large scripts.
      const windowFrom = Math.max(0, cursor - SQL_SIGNATURE_HELP_WINDOW_CHARS);
      const signature = getSqlFunctionSignatureHelp(currentState.doc.sliceString(windowFrom, cursor), cursor - windowFrom, props.databaseType, sqlDriverProfile.value, { truncatedPrefix: windowFrom > 0 });
      if (!signature) return null;
      return {
        pos: cursor,
        above: false,
        clip: false,
        create: () => ({ dom: createSqlSignatureTooltipDom(signature) }),
      };
    });

  codeMirrorRuntime.buildSqlCompletionExtension = () =>
    autocompletion({
      activateOnTyping: true,
      defaultKeymap: false,
      selectOnOpen: settingsStore.editorSettings.selectFirstCompletionOnOpen,
      compareCompletions: (a, b) => compareSqlCompletions(a, b, settingsStore.editorSettings.sortCompletionColumnsAlphabetically),
      // Keep normal completion lists virtualized; batch-field selection needs every row in the DOM.
      maxRenderedOptions: batchSelection.expandedRendering ? Number.MAX_SAFE_INTEGER : 100,
      optionClass: (completion) => ((completion as QueryCompletionOption).dbxBatchColumnSelectionAction ? "cm-batch-column-selection-action" : ""),
      addToOptions: [
        { position: 5, render: renderBatchColumnSelectionActionMarker },
        { position: 10, render: renderBatchColumnSelectionCheckbox },
      ],
      override: [async (context: CompletionContext) => provideSqlCompletions(context)],
    });

  const shellLineCommentHighlightPlugin = createShellLineCommentHighlight({ ViewPlugin, Decoration, highlightingFor, syntaxTree });

  codeMirrorRuntime.buildSqlLanguageExtension = () => [
    langSql.sql({
      dialect: createDbxCodeMirrorSqlDialect(langSql, props.syntaxDialect ?? props.dialect, props.databaseType, sqlDriverProfile.value),
    }),
    // Non-SQL editors (MongoDB shell) keep the SQL grammar for highlighting, so override the
    // comment marker that toggleLineComment reads from language data.
    Prec.highest(EditorState.languageData.of(() => [{ commentTokens: queryEditorCommentTokens(props.databaseType) }])),
    Prec.highest(EditorState.languageData.of(() => queryEditorWordLanguageData(props.databaseType))),
    // The SQL grammar does not tokenize `//`, so those comments are highlighted by hand.
    queryEditorLineCommentToken(props.databaseType) === "//" ? shellLineCommentHighlightPlugin : [],
  ];

  const MAX_SQL_SEMANTIC_HIGHLIGHT_WINDOWS = 32;

  const MAX_FULL_DOCUMENT_SQL_SEMANTIC_HIGHLIGHT_LENGTH = 128_000;

  const SQL_SEMANTIC_HIGHLIGHT_DEBOUNCE_MS = 100;

  const refreshSqlSemanticHighlightEffect = StateEffect.define<null>();

  codeMirrorRuntime.buildSqlSemanticHighlightExtension = () => [
    createSqlAliasHighlights({ databaseType: props.databaseType, dialect: sqlBehaviorDialect(), enabled: queryEditorSelectionLanguage() === "sql" }),
    ViewPlugin.fromClass(
      class {
        decorations: import("@codemirror/view").DecorationSet;
        private refreshTask = createDeferredEditorTask(() => {
          if (this.currentView.dom.isConnected) this.currentView.dispatch({ effects: refreshSqlSemanticHighlightEffect.of(null) });
        }, SQL_SEMANTIC_HIGHLIGHT_DEBOUNCE_MS);
        private cachedDoc: import("@codemirror/state").Text | null = null;
        private prewarmedDoc: import("@codemirror/state").Text | null = null;
        private cachedSql = "";
        private cachedDialectId = "";
        private cachedDatabaseType: DatabaseType | undefined;
        private cachedWindows: Array<{
          from: number;
          to: number;
          spans: Array<{ start: number; end: number }>;
        }> = [];

        constructor(private currentView: import("@codemirror/view").EditorView) {
          this.decorations = Decoration.none;
          this.decorations = this.buildDecorations(currentView);
        }

        update(update: import("@codemirror/view").ViewUpdate) {
          const refreshRequested = update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshSqlSemanticHighlightEffect)));
          if (update.docChanged) {
            this.decorations = this.decorations.map(update.changes);
            this.scheduleRefresh(update.view);
            return;
          }
          if (refreshRequested) {
            this.cancelRefresh();
            this.decorations = this.buildDecorations(update.view);
          } else if (update.viewportChanged) {
            // Keep existing decorations while scrolling. Parse only after the
            // viewport settles instead of blocking CodeMirror's layout update.
            this.scheduleRefresh(update.view);
          }
        }

        scheduleRefresh(currentView: import("@codemirror/view").EditorView) {
          this.currentView = currentView;
          this.refreshTask.schedule();
        }

        cancelRefresh() {
          this.refreshTask.cancel();
        }

        destroy() {
          this.cancelRefresh();
        }

        buildDecorations(currentView: import("@codemirror/view").EditorView) {
          const dialectId = resolveSqlDialectId({ databaseType: props.databaseType, dialect: sqlBehaviorDialect() });
          const doc = currentView.state.doc;
          if (this.cachedDoc !== doc || this.cachedDialectId !== dialectId || this.cachedDatabaseType !== props.databaseType) {
            this.cachedDoc = doc;
            this.cachedSql = doc.toString();
            this.cachedDialectId = dialectId;
            this.cachedDatabaseType = props.databaseType;
            this.cachedWindows = [];
          }

          const sql = this.cachedSql;
          const shouldPrewarmFullDocument = this.cachedWindows.length === 0 && this.prewarmedDoc !== doc && sql.length <= MAX_FULL_DOCUMENT_SQL_SEMANTIC_HIGHLIGHT_LENGTH;
          const windows: Array<{
            from: number;
            to: number;
            spans: Array<{ start: number; end: number }>;
          }> = [];
          const pendingWindows: Array<{ from: number; to: number }> = [];
          const rangesToHighlight = shouldPrewarmFullDocument ? [{ from: 0, to: sql.length }] : currentView.visibleRanges;
          for (const visibleRange of rangesToHighlight) {
            const cached = this.cachedWindows.find((candidate) => candidate.from <= visibleRange.from && candidate.to >= visibleRange.to);
            if (cached) {
              if (!windows.includes(cached)) windows.push(cached);
              continue;
            }

            const next = expandToSqlStatementWindow(sql, visibleRange.from, visibleRange.to, dialectId);
            const cachedWindow = this.cachedWindows.find((candidate) => candidate.from <= next.from && candidate.to >= next.to);
            if (cachedWindow) {
              if (!windows.includes(cachedWindow)) windows.push(cachedWindow);
              continue;
            }

            const previous = pendingWindows[pendingWindows.length - 1];
            if (previous && next.from <= previous.to) previous.to = Math.max(previous.to, next.to);
            else pendingWindows.push({ ...next });
          }

          if (pendingWindows.length > 0) {
            const requestedTo = Math.max(...pendingWindows.map((window) => window.to));
            const tree = ensureSyntaxTree(currentView.state, requestedTo, requestedTo === sql.length ? 250 : 25);
            if (!tree) {
              // The Lezer parse has not reached the pending windows yet (long
              // documents). Keep the decorations that are still valid and let
              // the deferred refresh rebuild them once parsing catches up —
              // returning an empty set here wiped table-name colors after
              // scrolling stopped or when a freshly mounted editor (tab
              // switch) had no later viewport change to trigger a rebuild.
              this.scheduleRefresh(currentView);
              return this.decorations;
            }
            if (shouldPrewarmFullDocument) this.prewarmedDoc = doc;
            for (const window of pendingWindows) {
              const entry = {
                ...window,
                spans: sqlSemanticTableNameSpansForSyntaxTree(sql, window, tree, {
                  databaseType: props.databaseType,
                  dialect: sqlBehaviorDialect(),
                }),
              };
              this.cachedWindows.push(entry);
              windows.push(entry);
            }
            if (this.cachedWindows.length > MAX_SQL_SEMANTIC_HIGHLIGHT_WINDOWS) {
              this.cachedWindows.splice(0, this.cachedWindows.length - MAX_SQL_SEMANTIC_HIGHLIGHT_WINDOWS);
            }
          }

          const ranges = windows.flatMap((window) => window.spans);
          return Decoration.set(
            ranges.map((range) =>
              Decoration.mark({
                class: "cm-sql-table-name",
                attributes: {
                  "data-sql-token": "table",
                },
              }).range(range.start, range.end),
            ),
            true,
          );
        }
      },
      { decorations: (value) => value.decorations },
    ),
    sqlSemanticHighlightTheme(EditorView),
    shellLineCommentTheme(EditorView),
  ];

  function createViewDecorations() {
    const currentStatementFrameExtension = currentStatementFrameLayer(
      { layer, RectangleMarker },
      (view) => {
        if (!settingsStore.editorSettings.showCurrentStatementFrame) return null;
        if (view.state.selection.ranges.some((range) => !range.empty)) return null;
        const cursorPos = view.state.selection.main.head;
        const boundaries = statementBoundariesForState(view.state);
        if (boundaries && !boundaries.fresh && boundaries.frameRange && cursorPos >= boundaries.frameRange.from && cursorPos <= boundaries.frameRange.to) {
          // Typing in progress: reuse the ChangeSet-shifted range instead of
          // re-parsing the whole document. The debounced refresh rebuilds and
          // repaints the exact frame once typing pauses.
          return { from: boundaries.frameRange.from, to: currentStatementFrameTo(view, { from: boundaries.frameRange.from, to: boundaries.frameRange.to, sql: "" }) };
        }
        let range = currentExecutableStatementRange(view);
        if (!range) {
          const cursorLine = view.state.doc.lineAt(cursorPos);
          cache.value = executableStatementRangeCacheForDoc(cache.value, view.state.doc, props.databaseType, sqlStatementParameterOptions());
          // Find ranges that overlap the cursor line, then expand to include
          // adjacent ranges (handles parser fragments from edge cases like
          // ultra-long comments splitting a statement).
          let mergedFrom = cursorLine.from;
          let mergedTo = cursorLine.from;
          let changed = true;
          while (changed) {
            changed = false;
            for (const cachedRange of cache.value.ranges) {
              // Only merge ranges that overlap the cursor line or are adjacent
              // to the current merged region
              if (cachedRange.from <= mergedTo && cachedRange.to >= mergedFrom) {
                const newFrom = Math.min(mergedFrom, cachedRange.from);
                const newTo = Math.max(mergedTo, cachedRange.to);
                if (newFrom !== mergedFrom || newTo !== mergedTo) {
                  mergedFrom = newFrom;
                  mergedTo = newTo;
                  changed = true;
                }
              }
            }
          }
          if (mergedTo > mergedFrom) {
            range = { from: mergedFrom, to: mergedTo, sql: view.state.doc.sliceString(mergedFrom, mergedTo) };
          }
        }
        if (boundaries) boundaries.frameRange = range ? { from: range.from, to: range.to } : null;
        if (!range) return null;
        return { from: range.from, to: currentStatementFrameTo(view, range) };
      },
      {
        shouldRefresh(update) {
          const refreshEffect = codeMirrorRuntime.statementBoundariesRefreshEffect;
          return !!refreshEffect && update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshEffect)));
        },
      },
    );

    function currentStatementFrameTo(view: import("@codemirror/view").EditorView, range: SqlTextRange): number {
      return currentStatementFrameRangeTo(view.state.doc, range);
    }

    const activeLineHighlighter = ViewPlugin.fromClass(
      class {
        decorations: import("@codemirror/view").DecorationSet;
        constructor(view: import("@codemirror/view").EditorView) {
          this.decorations = this.getDeco(view);
        }
        update(update: import("@codemirror/view").ViewUpdate) {
          if (update.docChanged || update.selectionSet) this.decorations = this.getDeco(update.view);
        }
        getDeco(view: import("@codemirror/view").EditorView) {
          if (!view.state.selection.main.empty) return Decoration.none;
          let lastLineStart = -1;
          const deco: any[] = [];
          for (const r of view.state.selection.ranges) {
            if (!r.empty) continue;
            const line = view.lineBlockAt(r.head);
            if (line.from > lastLineStart) {
              deco.push(Decoration.line({ class: "cm-activeLine" }).range(line.from));
              lastLineStart = line.from;
            }
          }
          return Decoration.set(deco);
        }
      },
      { decorations: (v) => v.decorations },
    );
    return { currentStatementFrameExtension, activeLineHighlighter };
  }
  return {
    createViewDecorations,
    buildPreviewRangeExtension: codeMirrorRuntime.buildPreviewRangeExtension,
    buildResultSourceRangeExtension: codeMirrorRuntime.buildResultSourceRangeExtension,
    buildSqlSignatureExtension: codeMirrorRuntime.buildSqlSignatureExtension,
    buildSqlLanguageExtension: codeMirrorRuntime.buildSqlLanguageExtension,
    buildSqlSemanticHighlightExtension: codeMirrorRuntime.buildSqlSemanticHighlightExtension,
    buildSqlCompletionExtension: codeMirrorRuntime.buildSqlCompletionExtension,
    buildSqlDiagnosticExtension: codeMirrorRuntime.buildSqlDiagnosticExtension,
  };
}
