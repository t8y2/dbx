import { ref, type ShallowRef, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { useToast } from "@/composables/useToast";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { createQueryEditorExecutionViewportOwnership } from "@/lib/editor/queryEditorExecutionViewport";
import { executionCandidateForMode, type SqlExecutionSnapshot, type SqlExecutionOverride, type SqlExecutionCandidate } from "@/lib/sql/sqlExecutionTarget";
import { buildExecutionCandidates, hasMultipleExecutionTargets, supportsExecutionTargetPicker } from "@/lib/sql/sqlStatementRanges";
import type { QueryEditorProps } from "./queryEditorTypes";

interface RequestExecuteOptions {
  ignoreSelection?: boolean;
  bypassPicker?: boolean;
  openInNewResultTab?: boolean;
}

interface QueryEditorExecutionOptions {
  props: Readonly<QueryEditorProps>;
  view: ShallowRef<EditorViewType | null>;
  editorRef: Ref<HTMLDivElement | undefined>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  executionViewportOwnership: ReturnType<typeof createQueryEditorExecutionViewportOwnership>;
  sqlStatementParameterOptions: () => Parameters<typeof buildExecutionCandidates>[3];
  setPreviewRange: (range: { from: number; to: number } | null) => void;
  emitExecutionRequest: (source: SqlExecutionOverride, openInNewResultTab?: boolean) => void;
  onExecute: (source: SqlExecutionOverride) => void;
}

export function useQueryEditorExecution(options: QueryEditorExecutionOptions) {
  const { props, view, editorRef, settingsStore, executionViewportOwnership, sqlStatementParameterOptions, setPreviewRange, emitExecutionRequest, onExecute } = options;
  const { t } = useI18n();
  const { toast } = useToast();

  // Execution target picker state
  const pickerVisible = ref(false);

  const pickerCandidates = ref<SqlExecutionCandidate[]>([]);

  const pickerActiveIndex = ref(0);

  const pickerAnchor = ref<{ left: number; top: number }>();

  /**
   * Captures a manual selection before a toolbar click can cause a platform
   * focus transition. The snapshot is immutable, so downstream execution keeps
   * the exact SQL and source offsets that were visible when the button was
   * pressed.
   */
  function captureExecutionSnapshot(): SqlExecutionSnapshot | undefined {
    const currentView = view.value;
    if (!currentView || currentView.state.selection.main.empty) return undefined;
    return sqlExecutionSnapshotFromView(currentView);
  }

  function requestExecute(options: RequestExecuteOptions = {}) {
    executionViewportOwnership.cancelPendingRequest();
    const currentView = view.value;
    if (!currentView) return false;
    currentView.focus();
    return requestExecuteFromView(currentView, currentView.state.selection.main.head, options);
  }

  function requestExecuteInNewResultTab() {
    return requestExecute({ bypassPicker: true, openInNewResultTab: true });
  }

  function requestExecuteFromView(currentView: EditorViewType, cursorPos: number, options: RequestExecuteOptions = {}) {
    const selection = currentView.state.selection.main;
    if (!options.ignoreSelection && !selection.empty) {
      // Has manual selection → execute directly, skip picker.
      emitExecutionRequest(sqlExecutionSnapshotFromView(currentView), options.openInNewResultTab);
      return true;
    }
    if (!supportsExecutionTargetPicker(props.databaseType)) {
      emitExecutionRequest(sqlExecutionSnapshotFromView(currentView), options.openInNewResultTab);
      return true;
    }
    // No selection → resolve the execution target, optionally via the picker.
    const doc = currentView.state.doc.toString();
    const parameterOptions = sqlStatementParameterOptions();
    const candidates = buildExecutionCandidates(doc, cursorPos, props.databaseType, parameterOptions);
    const executeMode = settingsStore.editorSettings.executeMode;
    if (candidates.length === 0) {
      if (executeMode === "current") toast(t("editor.noExecutableStatementAtCursor"), 3000);
      return true;
    }
    const candidate = executionCandidateForMode(candidates, executeMode, {
      executeAllOnBlankLine: settingsStore.editorSettings.executeAllOnBlankLine,
    });
    if (!candidate) {
      toast(t("editor.noExecutableStatementAtCursor"), 3000);
      return true;
    }
    // The execution shortcut keeps executing the configured target (cursor/all) directly:
    // it stays keyboard-driven and never pops the picker, which is reserved for click entry points.
    if (options.bypassPicker || !settingsStore.editorSettings.showExecutionTargetPicker || !hasMultipleExecutionTargets(doc, props.databaseType, parameterOptions)) {
      emitExecutionRequest(sqlExecutionSnapshotForRange(currentView, candidate), options.openInNewResultTab);
      return true;
    }
    closePicker();
    pickerCandidates.value = candidates;
    pickerActiveIndex.value = 0;
    pickerAnchor.value = executionPickerAnchor(currentView, cursorPos, candidates.length);
    pickerVisible.value = true;
    setPreviewRange({ from: candidates[0].from, to: candidates[0].to });
    return true;
  }

  function executionPickerAnchor(currentView: EditorViewType, cursorPos: number, candidateCount: number): { left: number; top: number } | undefined {
    const cursorRect = currentView.coordsAtPos(cursorPos);
    const rootRect = editorRef.value?.getBoundingClientRect();
    if (!cursorRect || !rootRect) return undefined;

    const verticalGap = 8;
    const pickerHeight = 40 + Math.max(1, candidateCount) * 36;
    const verticalMargin = 12;
    const left = rootRect.width / 2;
    const cursorBottom = cursorRect.bottom - rootRect.top;
    const maxTop = Math.max(verticalMargin, rootRect.height - pickerHeight - verticalMargin);
    const top = Math.min(cursorBottom + verticalGap, maxTop);

    return { left, top };
  }

  function onPickerActiveIndexChange(index: number) {
    pickerActiveIndex.value = index;
    const candidate = pickerCandidates.value[index];
    if (candidate) {
      setPreviewRange({ from: candidate.from, to: candidate.to });
    }
  }

  function onPickerConfirm(candidate: SqlExecutionCandidate) {
    const currentView = view.value;
    closePicker();
    onExecute(currentView ? sqlExecutionSnapshotForRange(currentView, candidate) : candidate.sql);
  }

  function closePicker() {
    pickerVisible.value = false;
    pickerAnchor.value = undefined;
    setPreviewRange(null);
    // Restore focus to the CodeMirror editor.
    view.value?.focus();
  }

  function sqlExecutionSnapshotFromView(currentView: EditorViewType): SqlExecutionSnapshot {
    const selection = currentView.state.selection.main;
    return {
      fullSql: currentView.state.doc.toString(),
      selectedSql: currentView.state.sliceDoc(selection.from, selection.to),
      cursorPos: selection.head,
      selectionFrom: selection.from,
      selectionTo: selection.to,
    };
  }

  function sqlExecutionSnapshotForRange(currentView: EditorViewType, range: Pick<SqlExecutionCandidate, "sql" | "from" | "to">): SqlExecutionSnapshot {
    return {
      fullSql: currentView.state.doc.toString(),
      selectedSql: range.sql,
      cursorPos: currentView.state.selection.main.head,
      selectionFrom: range.from,
      selectionTo: range.to,
    };
  }

  return {
    pickerVisible,
    pickerCandidates,
    pickerActiveIndex,
    pickerAnchor,
    captureExecutionSnapshot,
    requestExecute,
    requestExecuteInNewResultTab,
    requestExecuteFromView,
    executionPickerAnchor,
    onPickerActiveIndexChange,
    onPickerConfirm,
    closePicker,
    sqlExecutionSnapshotFromView,
    sqlExecutionSnapshotForRange,
  };
}
