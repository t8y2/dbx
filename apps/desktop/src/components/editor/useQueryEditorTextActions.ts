import { ref, computed, type ShallowRef, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { useToast } from "@/composables/useToast";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { CodeSnapshotSource } from "@/lib/codeSnapshot/codeSnapshot";
import { copyToClipboard, readTextFromClipboard } from "@/lib/common/clipboard";
import { blankLineDeletionChanges, replaceSelectedEditorText } from "@/lib/editor/queryEditorTextEdits";
import { queryEditorClipboardPasteChange } from "@/lib/editor/queryEditorClipboardPaste";
import { buildSqlInConditionFromPasteSource, insertTextForSqlInCondition } from "@/lib/sql/sqlInListPaste";
import { convertSqlSelectionCase, type SqlSelectionCaseMode } from "@/lib/sql/sqlSelectionCase";
import { convertToNextNamingStyle } from "@/lib/naming/namingStyleConverter";
import { copySqlAsRichText } from "@/lib/sql/sqlRichText";
import { supportsQueryEditorBlockComments, supportsSqlInListPaste } from "@/lib/database/databaseFeatureSupport";
import type { QueryEditorProps } from "./queryEditorTypes";

interface QueryEditorTextActionsOptions {
  props: Readonly<QueryEditorProps>;
  view: ShallowRef<EditorViewType | null>;
  selectedSql: Ref<string>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  sqlBehaviorDialect: () => QueryEditorProps["dialect"];
  focusEditor: () => void;
  getEditorSelection: () => typeof import("@codemirror/state").EditorSelection | null;
  toggleLineComment: (view: EditorViewType) => void;
  toggleBlockComment: (view: EditorViewType) => void;
}

export function useQueryEditorTextActions(options: QueryEditorTextActionsOptions) {
  const { props, view, selectedSql, settingsStore, sqlBehaviorDialect, focusEditor, getEditorSelection, toggleLineComment, toggleBlockComment } = options;
  const { t } = useI18n();
  const { toast } = useToast();
  const canCopySelectedSql = computed(() => selectedSql.value.length > 0);

  // Delimited list dialog state
  const delimitedListOpen = ref(false);

  const delimitedListSelectedText = ref("");

  const codeSnapshotOpen = ref(false);

  const codeSnapshotSource = ref<CodeSnapshotSource | null>(null);

  function openDelimitedListDialog() {
    if (props.readOnly) return;
    if (!selectedSql.value.trim()) {
      toast(t("editor.delimitedList.selectFirst"), 3000);
      return;
    }
    delimitedListSelectedText.value = selectedSql.value;
    delimitedListOpen.value = true;
    focusEditor();
  }

  function applyDelimitedListResult(result: string) {
    const currentView = view.value;
    if (!currentView || props.readOnly) return;
    if (!replaceSelectedEditorText(currentView, result)) return;
    focusEditor();
  }

  async function copySelectedSqlFromContextMenu() {
    if (!canCopySelectedSql.value) return;
    try {
      await copyToClipboard(selectedSql.value);
      toast(t("grid.copied"));
      focusEditor();
    } catch (e: any) {
      toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
    }
  }

  // 富文本复制：写入 text/html + text/plain，粘贴到邮件/Word/IM 时保留语法高亮。
  async function copySelectedSqlAsRichTextFromContextMenu() {
    if (!canCopySelectedSql.value) return;
    try {
      await copySqlAsRichText(selectedSql.value);
      toast(t("grid.copied"));
      focusEditor();
    } catch (e: any) {
      toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
    }
  }

  async function cutSelectedSqlFromContextMenu() {
    if (!canCopySelectedSql.value) return;
    const currentView = view.value;
    if (!currentView) return;
    try {
      await copyToClipboard(selectedSql.value);
      // 剪切：复制后删除选中内容
      const selection = currentView.state.selection.main;
      if (!selection.empty) {
        currentView.dispatch({
          changes: { from: selection.from, to: selection.to },
          selection: { anchor: selection.from, head: selection.from },
          scrollIntoView: true,
          userEvent: "input.cut",
        });
      }
      toast(t("grid.cut"));
      focusEditor();
    } catch (e: any) {
      toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
    }
  }

  async function pasteClipboardSqlFromContextMenu() {
    if (props.readOnly) return;
    const currentView = view.value;
    if (!currentView) return;
    try {
      const text = await readTextFromClipboard();
      if (!text) return;
      const selection = currentView.state.selection.main;
      // 粘贴：替换选中内容或在光标处插入
      currentView.dispatch({
        ...queryEditorClipboardPasteChange(text, selection.from, selection.to),
        scrollIntoView: true,
        userEvent: "input.paste",
      });
      focusEditor();
    } catch (e: any) {
      toast(t("editor.contextMenu.pasteClipboardReadFailed", { message: e?.message || String(e) }), 5000);
    }
  }

  function toggleCommentFromContextMenu() {
    const currentView = view.value;
    if (!currentView || props.readOnly) return;
    toggleLineComment(currentView);
    focusEditor();
  }

  function toggleBlockCommentFromContextMenu() {
    const currentView = view.value;
    if (!currentView || props.readOnly || !supportsQueryEditorBlockComments(props.databaseType)) return;
    toggleBlockComment(currentView);
    focusEditor();
  }

  function selectAllSqlFromContextMenu() {
    const currentView = view.value;
    if (!currentView) return;
    currentView.dispatch({
      selection: { anchor: 0, head: currentView.state.doc.length },
      scrollIntoView: true,
    });
    focusEditor();
  }

  function convertSelectedSqlCase(mode: SqlSelectionCaseMode): boolean {
    const currentView = view.value;
    const EditorSelection = getEditorSelection();
    if (!currentView || !EditorSelection) return false;

    const state = currentView.state;
    const documentText = state.doc.toString();
    const transaction = state.changeByRange((range) => {
      if (range.empty) return { range };

      const convertedText = convertSqlSelectionCase(documentText, { from: range.from, to: range.to }, mode, sqlBehaviorDialect());
      return {
        changes: { from: range.from, to: range.to, insert: convertedText },
        range: EditorSelection.range(range.from, range.from + convertedText.length),
      };
    });

    if (!transaction.changes.empty) {
      currentView.dispatch({
        ...transaction,
        scrollIntoView: true,
        userEvent: "input",
      });
      focusEditor();
      return true;
    }
    return false;
  }

  function convertSelectedNamingStyle(): boolean {
    const currentView = view.value;
    const EditorSelection = getEditorSelection();
    if (!currentView || !EditorSelection) return false;

    const state = currentView.state;
    const transaction = state.changeByRange((range) => {
      if (range.empty) return { range };

      const selectedText = state.doc.sliceString(range.from, range.to);
      const result = convertToNextNamingStyle(selectedText);
      return {
        changes: { from: range.from, to: range.to, insert: result.text },
        range: EditorSelection.range(range.from, range.from + result.text.length),
      };
    });

    if (!transaction.changes.empty) {
      currentView.dispatch({
        ...transaction,
        scrollIntoView: true,
        userEvent: "input",
      });
      focusEditor();
      return true;
    }
    return false;
  }

  async function pasteClipboardAsSqlInCondition(): Promise<boolean> {
    if (!supportsSqlInListPaste(props.databaseType)) return false;
    if (props.readOnly) return false;
    const currentView = view.value;
    if (!currentView) return false;

    const selection = currentView.state.selection.main;
    const selectedSource = selection.empty ? "" : currentView.state.sliceDoc(selection.from, selection.to);
    let source = selectedSource;
    if (!source) {
      try {
        source = await readTextFromClipboard();
      } catch (e: any) {
        toast(
          t("editor.exPasteClipboardReadFailed", {
            message: e?.message || String(e),
          }),
          5000,
        );
        focusEditor();
        return false;
      }
    }

    const result = buildSqlInConditionFromPasteSource(source, settingsStore.editorSettings.sqlFormatter.keywordCase);
    if (!result.ok) {
      const key = result.reason === "too-large" ? "editor.exPasteTooLarge" : result.reason === "too-many-values" ? "editor.exPasteTooManyValues" : result.reason === "not-list" ? "editor.exPasteNotList" : "editor.exPasteNoValues";
      toast(t(key, { limit: result.limit ?? 0 }), 5000);
      focusEditor();
      return false;
    }

    if (view.value !== currentView || props.readOnly) return false;
    const state = currentView.state;
    const line = state.doc.lineAt(selection.from);
    const prefix = state.sliceDoc(line.from, selection.from);
    const insertText = insertTextForSqlInCondition(result.sql, prefix);

    currentView.dispatch({
      changes: { from: selection.from, to: selection.to, insert: insertText },
      selection: { anchor: selection.from + insertText.length },
      scrollIntoView: true,
      userEvent: "input.paste",
    });
    currentView.focus();
    toast(t("editor.exPastePasted", { count: result.valueCount }), 2000);
    return true;
  }

  function deleteEmptyLines() {
    const currentView = view.value;
    if (!currentView || props.readOnly) return;

    const state = currentView.state;
    const selection = state.selection.main;
    const changes = blankLineDeletionChanges(state.doc, selection);
    if (changes.length === 0) return;

    currentView.dispatch({
      changes,
      scrollIntoView: true,
    });
    focusEditor();
  }

  function openCodeSnapshot() {
    if (selectedSql.value.trim()) {
      codeSnapshotSource.value = { code: selectedSql.value, lang: "sql" };
      codeSnapshotOpen.value = true;
    }
  }

  return {
    delimitedListOpen,
    delimitedListSelectedText,
    codeSnapshotOpen,
    codeSnapshotSource,
    openCodeSnapshot,
    openDelimitedListDialog,
    applyDelimitedListResult,
    copySelectedSqlFromContextMenu,
    copySelectedSqlAsRichTextFromContextMenu,
    cutSelectedSqlFromContextMenu,
    pasteClipboardSqlFromContextMenu,
    toggleCommentFromContextMenu,
    toggleBlockCommentFromContextMenu,
    selectAllSqlFromContextMenu,
    convertSelectedSqlCase,
    convertSelectedNamingStyle,
    pasteClipboardAsSqlInCondition,
    deleteEmptyLines,
  };
}
