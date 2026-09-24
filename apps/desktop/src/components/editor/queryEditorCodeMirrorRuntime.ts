import { StateEffect } from "@codemirror/state";
import type { StatementExecutionMarker } from "@/lib/tabs/tabPresentation";
import { type SqlSemanticDiagnostic } from "@/lib/sql/semantic/diagnostics";

interface CodeMirrorBindings {
  editorViewModule: typeof import("@codemirror/view") | null;
  codeMirrorLineNumbers: typeof import("@codemirror/view").lineNumbers | null;
  codeMirrorPrec: typeof import("@codemirror/state").Prec | null;
  codeMirrorEditorSelection: typeof import("@codemirror/state").EditorSelection | null;
  hoverCloseEffect: StateEffect<unknown> | null;
  fontThemeComp: import("@codemirror/state").Compartment | null;
  codeMirrorTheme: import("@codemirror/state").Compartment | null;
  wordWrapComp: import("@codemirror/state").Compartment | null;
  showWhitespaceComp: import("@codemirror/state").Compartment | null;
  lineNumbersComp: import("@codemirror/state").Compartment | null;
  vimModeComp: import("@codemirror/state").Compartment | null;
  closeBracketsComp: import("@codemirror/state").Compartment | null;
  sqlLanguageComp: import("@codemirror/state").Compartment | null;
  sqlSemanticHighlightComp: import("@codemirror/state").Compartment | null;
  sqlSignatureComp: import("@codemirror/state").Compartment | null;
  codeMirrorCloseBrackets: typeof import("@codemirror/autocomplete").closeBrackets | null;
  codeMirrorCloseBracketsKeymap: readonly import("@codemirror/view").KeyBinding[] | null;
  readOnlyComp: import("@codemirror/state").Compartment | null;
  runGutterComp: import("@codemirror/state").Compartment | null;
  runKeymapComp: import("@codemirror/state").Compartment | null;
  historyResetComp: import("@codemirror/state").Compartment | null;
  codeMirrorHistory: typeof import("@codemirror/commands").history | null;
  defaultKeymapComp: import("@codemirror/state").Compartment | null;
  completionComp: import("@codemirror/state").Compartment | null;
  diagnosticComp: import("@codemirror/state").Compartment | null;
  codeMirrorVim: typeof import("@replit/codemirror-vim").vim | null;
  codeMirrorVimApi: typeof import("@replit/codemirror-vim").Vim | null;
  codeMirrorGetVimCm: typeof import("@replit/codemirror-vim").getCM | null;
  codeMirrorVimImportPromise: Promise<typeof import("@replit/codemirror-vim")> | null;
  dbxVimCommandsConfigured: boolean;
  buildSqlDiagnosticExtension: (() => import("@codemirror/state").Extension) | null;
  buildSqlSignatureExtension: (() => import("@codemirror/state").Extension) | null;
  buildSqlCompletionExtension: (() => import("@codemirror/state").Extension) | null;
  buildSqlLanguageExtension: (() => import("@codemirror/state").Extension) | null;
  buildSqlSemanticHighlightExtension: (() => import("@codemirror/state").Extension) | null;
  codeMirrorSnippetCompletion: typeof import("@codemirror/autocomplete").snippetCompletion;
  codeMirrorCompletionStatus: typeof import("@codemirror/autocomplete").completionStatus | null;
  codeMirrorAcceptCompletion: typeof import("@codemirror/autocomplete").acceptCompletion | null;
  codeMirrorCurrentCompletions: typeof import("@codemirror/autocomplete").currentCompletions | null;
  codeMirrorSelectedCompletionIndex: typeof import("@codemirror/autocomplete").selectedCompletionIndex | null;
  codeMirrorSelectedCompletion: typeof import("@codemirror/autocomplete").selectedCompletion | null;
  codeMirrorSetSelectedCompletion: typeof import("@codemirror/autocomplete").setSelectedCompletion | null;
  codeMirrorMoveCompletionSelection: typeof import("@codemirror/autocomplete").moveCompletionSelection | null;
  codeMirrorSelectFirstCompletion: import("@codemirror/view").Command | null;
  codeMirrorStartCompletion: typeof import("@codemirror/autocomplete").startCompletion | null;
  codeMirrorCloseCompletion: typeof import("@codemirror/autocomplete").closeCompletion | null;
  codeMirrorInsertCompletionText: typeof import("@codemirror/autocomplete").insertCompletionText | null;
  codeMirrorNextSnippetField: typeof import("@codemirror/autocomplete").nextSnippetField | null;
  codeMirrorIndentMore: typeof import("@codemirror/commands").indentMore | null;
  codeMirrorIndentLess: typeof import("@codemirror/commands").indentLess | null;
  codeMirrorCopyLineDown: typeof import("@codemirror/commands").copyLineDown | null;
  codeMirrorCopyLineUp: typeof import("@codemirror/commands").copyLineUp | null;
  codeMirrorDeleteLine: typeof import("@codemirror/commands").deleteLine | null;
  codeMirrorMoveLineUp: typeof import("@codemirror/commands").moveLineUp | null;
  codeMirrorMoveLineDown: typeof import("@codemirror/commands").moveLineDown | null;
  codeMirrorUndo: typeof import("@codemirror/commands").undo | null;
  codeMirrorRedo: typeof import("@codemirror/commands").redo | null;
  codeMirrorSelectAll: typeof import("@codemirror/commands").selectAll | null;
  codeMirrorInsertNewlineKeepIndent: typeof import("@codemirror/commands").insertNewlineKeepIndent | null;
  codeMirrorToggleLineComment: typeof import("@codemirror/commands").toggleLineComment | null;
  codeMirrorToggleBlockComment: typeof import("@codemirror/commands").toggleBlockComment | null;
  codeMirrorDefaultKeymap: readonly import("@codemirror/view").KeyBinding[] | null;
  codeMirrorToggleFold: typeof import("@codemirror/language").toggleFold | null;
  setSqlDiagnosticsEffect: import("@codemirror/state").StateEffectType<SqlSemanticDiagnostic[]> | null;
  setPreviewRangeEffect:
    | import("@codemirror/state").StateEffectType<{
        from: number;
        to: number;
      } | null>
    | null;
  setResultSourceRangeEffect:
    | import("@codemirror/state").StateEffectType<{
        from: number;
        to: number;
      } | null>
    | null;
  setStatementExecutionMarkersEffect: import("@codemirror/state").StateEffectType<StatementExecutionMarker[]> | null;
  previewRangeComp: import("@codemirror/state").Compartment | null;
  buildPreviewRangeExtension: (() => import("@codemirror/state").Extension) | null;
  buildResultSourceRangeExtension: (() => import("@codemirror/state").Extension) | null;
  buildRunStatementGutterExtension: (() => import("@codemirror/state").Extension) | null;
  indentComp: import("@codemirror/state").Compartment | null;
  codeMirrorIndentUnit: typeof import("@codemirror/language").indentUnit | null;
  statementBoundariesRefreshEffect: import("@codemirror/state").StateEffectType<null> | null;
}

type ReadyCodeMirrorBindings = CodeMirrorBindings & {
  [Key in
    | "editorViewModule"
    | "hoverCloseEffect"
    | "codeMirrorLineNumbers"
    | "codeMirrorPrec"
    | "codeMirrorEditorSelection"
    | "codeMirrorSnippetCompletion"
    | "fontThemeComp"
    | "codeMirrorTheme"
    | "wordWrapComp"
    | "showWhitespaceComp"
    | "lineNumbersComp"
    | "vimModeComp"
    | "closeBracketsComp"
    | "sqlLanguageComp"
    | "sqlSemanticHighlightComp"
    | "sqlSignatureComp"
    | "codeMirrorCloseBrackets"
    | "codeMirrorCloseBracketsKeymap"
    | "readOnlyComp"
    | "runGutterComp"
    | "runKeymapComp"
    | "historyResetComp"
    | "defaultKeymapComp"
    | "completionComp"
    | "diagnosticComp"
    | "previewRangeComp"
    | "indentComp"
    | "setSqlDiagnosticsEffect"
    | "statementBoundariesRefreshEffect"
    | "codeMirrorCompletionStatus"
    | "codeMirrorAcceptCompletion"
    | "codeMirrorCurrentCompletions"
    | "codeMirrorSelectedCompletion"
    | "codeMirrorSelectedCompletionIndex"
    | "codeMirrorSetSelectedCompletion"
    | "codeMirrorMoveCompletionSelection"
    | "codeMirrorSelectFirstCompletion"
    | "codeMirrorCloseCompletion"
    | "codeMirrorStartCompletion"
    | "codeMirrorInsertCompletionText"
    | "codeMirrorNextSnippetField"
    | "codeMirrorIndentMore"
    | "codeMirrorIndentLess"
    | "codeMirrorCopyLineDown"
    | "codeMirrorCopyLineUp"
    | "codeMirrorDeleteLine"
    | "codeMirrorMoveLineUp"
    | "codeMirrorMoveLineDown"
    | "codeMirrorUndo"
    | "codeMirrorRedo"
    | "codeMirrorHistory"
    | "codeMirrorSelectAll"
    | "codeMirrorInsertNewlineKeepIndent"
    | "codeMirrorToggleLineComment"
    | "codeMirrorToggleBlockComment"
    | "codeMirrorDefaultKeymap"
    | "codeMirrorToggleFold"
    | "codeMirrorIndentUnit"]: NonNullable<CodeMirrorBindings[Key]>;
};

export function createQueryEditorCodeMirrorRuntime() {
  const runtime: CodeMirrorBindings = {
    editorViewModule: null,
    codeMirrorLineNumbers: null,
    codeMirrorPrec: null,
    codeMirrorEditorSelection: null,
    hoverCloseEffect: null,
    fontThemeComp: null,
    codeMirrorTheme: null,
    wordWrapComp: null,
    showWhitespaceComp: null,
    lineNumbersComp: null,
    vimModeComp: null,
    closeBracketsComp: null,
    sqlLanguageComp: null,
    sqlSemanticHighlightComp: null,
    sqlSignatureComp: null,
    codeMirrorCloseBrackets: null,
    codeMirrorCloseBracketsKeymap: null,
    readOnlyComp: null,
    runGutterComp: null,
    runKeymapComp: null,
    historyResetComp: null,
    codeMirrorHistory: null,
    defaultKeymapComp: null,
    completionComp: null,
    diagnosticComp: null,
    codeMirrorVim: null,
    codeMirrorVimApi: null,
    codeMirrorGetVimCm: null,
    codeMirrorVimImportPromise: null,
    dbxVimCommandsConfigured: false,
    buildSqlDiagnosticExtension: null,
    buildSqlSignatureExtension: null,
    buildSqlCompletionExtension: null,
    buildSqlLanguageExtension: null,
    buildSqlSemanticHighlightExtension: null,
    codeMirrorSnippetCompletion: undefined!,
    codeMirrorCompletionStatus: null,
    codeMirrorAcceptCompletion: null,
    codeMirrorCurrentCompletions: null,
    codeMirrorSelectedCompletionIndex: null,
    codeMirrorSelectedCompletion: null,
    codeMirrorSetSelectedCompletion: null,
    codeMirrorMoveCompletionSelection: null,
    codeMirrorSelectFirstCompletion: null,
    codeMirrorStartCompletion: null,
    codeMirrorCloseCompletion: null,
    codeMirrorInsertCompletionText: null,
    codeMirrorNextSnippetField: null,
    codeMirrorIndentMore: null,
    codeMirrorIndentLess: null,
    codeMirrorCopyLineDown: null,
    codeMirrorCopyLineUp: null,
    codeMirrorDeleteLine: null,
    codeMirrorMoveLineUp: null,
    codeMirrorMoveLineDown: null,
    codeMirrorUndo: null,
    codeMirrorRedo: null,
    codeMirrorSelectAll: null,
    codeMirrorInsertNewlineKeepIndent: null,
    codeMirrorToggleLineComment: null,
    codeMirrorToggleBlockComment: null,
    codeMirrorDefaultKeymap: null,
    codeMirrorToggleFold: null,
    setSqlDiagnosticsEffect: null,
    setPreviewRangeEffect: null,
    setResultSourceRangeEffect: null,
    setStatementExecutionMarkersEffect: null,
    previewRangeComp: null,
    buildPreviewRangeExtension: null,
    buildResultSourceRangeExtension: null,
    buildRunStatementGutterExtension: null,
    indentComp: null,
    codeMirrorIndentUnit: null,
    statementBoundariesRefreshEffect: null,
  };
  return Object.assign(runtime, {
    async load() {
      const [
        {
          EditorView,
          keymap,
          rectangularSelection,
          hoverTooltip,
          showTooltip,
          closeHoverTooltips,
          Decoration,
          tooltips,
          gutter,
          GutterMarker,
          lineNumberMarkers,
          lineNumbers,
          highlightActiveLineGutter,
          highlightSpecialChars,
          highlightWhitespace,
          WidgetType,
          drawSelection,
          dropCursor,
          crosshairCursor,
          scrollPastEnd,
          ViewPlugin,
          layer,
          RectangleMarker,
        },
        { EditorState, EditorSelection, Compartment, Prec, RangeSet, StateEffect, StateField },
        langSql,
        {
          autocompletion,
          startCompletion,
          acceptCompletion,
          closeBrackets,
          closeBracketsKeymap,
          snippetCompletion,
          completionStatus,
          completionKeymap,
          insertCompletionText,
          nextSnippetField,
          closeCompletion,
          moveCompletionSelection,
          selectedCompletion,
          selectedCompletionIndex,
          currentCompletions,
          setSelectedCompletion,
        },
        { copyLineDown, copyLineUp, deleteLine, indentLess, indentMore, insertNewlineKeepIndent, moveLineDown, moveLineUp, redo, selectAll, undo, toggleLineComment, toggleBlockComment, history, defaultKeymap, historyKeymap },
        { bracketMatching, foldGutter, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle, foldKeymap, toggleFold, ensureSyntaxTree, highlightingFor, syntaxTree },
        { searchKeymap },
      ] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("@codemirror/autocomplete"), import("@codemirror/commands"), import("@codemirror/language"), import("@codemirror/search")]);
      runtime.editorViewModule = {
        EditorView,
        keymap,
        rectangularSelection,
        highlightWhitespace,
        WidgetType,
        Decoration,
        ViewPlugin,
      } as typeof import("@codemirror/view");
      runtime.hoverCloseEffect = closeHoverTooltips;
      runtime.codeMirrorLineNumbers = lineNumbers;
      runtime.codeMirrorPrec = Prec;
      runtime.codeMirrorEditorSelection = EditorSelection;
      runtime.codeMirrorSnippetCompletion = snippetCompletion;
      runtime.fontThemeComp = new Compartment();
      runtime.codeMirrorTheme = new Compartment();
      runtime.wordWrapComp = new Compartment();
      runtime.showWhitespaceComp = new Compartment();
      runtime.lineNumbersComp = new Compartment();
      runtime.vimModeComp = new Compartment();
      runtime.closeBracketsComp = new Compartment();
      runtime.sqlLanguageComp = new Compartment();
      runtime.sqlSemanticHighlightComp = new Compartment();
      runtime.sqlSignatureComp = new Compartment();
      runtime.codeMirrorCloseBrackets = closeBrackets;
      runtime.codeMirrorCloseBracketsKeymap = closeBracketsKeymap;
      runtime.readOnlyComp = new Compartment();
      runtime.runGutterComp = new Compartment();
      runtime.runKeymapComp = new Compartment();
      runtime.historyResetComp = new Compartment();
      runtime.defaultKeymapComp = new Compartment();
      runtime.completionComp = new Compartment();
      runtime.diagnosticComp = new Compartment();
      runtime.previewRangeComp = new Compartment();
      runtime.indentComp = new Compartment();
      runtime.setSqlDiagnosticsEffect = StateEffect.define<SqlSemanticDiagnostic[]>();
      runtime.statementBoundariesRefreshEffect = StateEffect.define<null>();
      runtime.codeMirrorCompletionStatus = completionStatus;
      runtime.codeMirrorAcceptCompletion = acceptCompletion;
      runtime.codeMirrorCurrentCompletions = currentCompletions;
      runtime.codeMirrorSelectedCompletion = selectedCompletion;
      runtime.codeMirrorSelectedCompletionIndex = selectedCompletionIndex;
      runtime.codeMirrorSetSelectedCompletion = setSelectedCompletion;
      runtime.codeMirrorMoveCompletionSelection = moveCompletionSelection;
      runtime.codeMirrorSelectFirstCompletion = moveCompletionSelection(true);
      runtime.codeMirrorCloseCompletion = closeCompletion;
      runtime.codeMirrorStartCompletion = startCompletion;
      runtime.codeMirrorInsertCompletionText = insertCompletionText;
      runtime.codeMirrorNextSnippetField = nextSnippetField;
      runtime.codeMirrorIndentMore = indentMore;
      runtime.codeMirrorIndentLess = indentLess;
      runtime.codeMirrorCopyLineDown = copyLineDown;
      runtime.codeMirrorCopyLineUp = copyLineUp;
      runtime.codeMirrorDeleteLine = deleteLine;
      runtime.codeMirrorMoveLineUp = moveLineUp;
      runtime.codeMirrorMoveLineDown = moveLineDown;
      runtime.codeMirrorUndo = undo;
      runtime.codeMirrorRedo = redo;
      runtime.codeMirrorHistory = history;
      runtime.codeMirrorSelectAll = selectAll;
      runtime.codeMirrorInsertNewlineKeepIndent = insertNewlineKeepIndent;
      runtime.codeMirrorToggleLineComment = toggleLineComment;
      runtime.codeMirrorToggleBlockComment = toggleBlockComment;
      runtime.codeMirrorDefaultKeymap = defaultKeymap;
      runtime.codeMirrorToggleFold = toggleFold;
      runtime.codeMirrorIndentUnit = indentUnit;
      return {
        runtime: runtime as ReadyCodeMirrorBindings,
        EditorView,
        keymap,
        rectangularSelection,
        hoverTooltip,
        showTooltip,
        closeHoverTooltips,
        Decoration,
        tooltips,
        gutter,
        GutterMarker,
        lineNumberMarkers,
        lineNumbers,
        highlightActiveLineGutter,
        highlightSpecialChars,
        highlightWhitespace,
        WidgetType,
        drawSelection,
        dropCursor,
        crosshairCursor,
        scrollPastEnd,
        ViewPlugin,
        layer,
        RectangleMarker,
        EditorState,
        EditorSelection,
        Compartment,
        Prec,
        RangeSet,
        StateEffect,
        StateField,
        langSql,
        autocompletion,
        startCompletion,
        acceptCompletion,
        closeBrackets,
        closeBracketsKeymap,
        snippetCompletion,
        completionStatus,
        completionKeymap,
        insertCompletionText,
        nextSnippetField,
        closeCompletion,
        moveCompletionSelection,
        selectedCompletion,
        selectedCompletionIndex,
        currentCompletions,
        setSelectedCompletion,
        copyLineDown,
        copyLineUp,
        deleteLine,
        indentLess,
        indentMore,
        insertNewlineKeepIndent,
        moveLineDown,
        moveLineUp,
        redo,
        selectAll,
        undo,
        toggleLineComment,
        toggleBlockComment,
        history,
        defaultKeymap,
        historyKeymap,
        bracketMatching,
        foldGutter,
        indentOnInput,
        indentUnit,
        syntaxHighlighting,
        defaultHighlightStyle,
        foldKeymap,
        toggleFold,
        ensureSyntaxTree,
        highlightingFor,
        syntaxTree,
        searchKeymap,
      };
    },
  });
}

export type QueryEditorCodeMirrorRuntime = ReturnType<typeof createQueryEditorCodeMirrorRuntime>;
export type QueryEditorCodeMirrorModules = Awaited<ReturnType<QueryEditorCodeMirrorRuntime["load"]>>;
