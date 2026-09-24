<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { AlignLeft, Camera, CaseLower, CaseSensitive, CaseUpper, ClipboardPaste, Code2, Columns3, Download, Eye, FileCode, Highlighter, MessageSquareText, Minimize2, Pencil, PencilRuler, Play, Copy, List, Scissors, Search, Sparkles, Table2, TextSelect, Trash2 } from "@lucide/vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { canFormatSqlForDatabaseType } from "@/lib/sql/sqlFormatter";
import { supportsQueryEditorBlockComments } from "@/lib/database/databaseFeatureSupport";
import { normalizeShortcutSettings, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";
import { queryContextObjectActions, type QueryContextObjectAction } from "@/lib/sql/queryCursorTableTarget";
import type { SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import type { QueryEditorProps } from "./queryEditorTypes";

export interface QueryEditorContextMenuState {
  readOnly: QueryEditorProps["readOnly"];
  hideExecutionControls: QueryEditorProps["hideExecutionControls"];
  databaseType: QueryEditorProps["databaseType"];
  selectedSql: string;
  executableSql: string;
  previewContextSql: string;
  contextObjectTarget: SqlObjectNavigationTarget | null;
  shortcuts: ShortcutSettings;
  expandSelectStar: (() => void) | undefined;
}

export interface QueryEditorContextMenuActions {
  executeFromContextMenu: () => void;
  executeInNewResultTabFromContextMenu: () => void;
  requestPreviewChanges: (sql?: string) => void;
  exportQueryFromContextMenu: (format: "csv" | "xlsx" | "txt") => void;
  toggleCommentFromContextMenu: () => void;
  toggleBlockCommentFromContextMenu: () => void;
  formatCurrentSql: () => void;
  compressCurrentSql: () => void;
  copySelectedSqlFromContextMenu: () => void;
  copySelectedSqlAsRichTextFromContextMenu: () => void;
  cutSelectedSqlFromContextMenu: () => void;
  pasteClipboardSqlFromContextMenu: () => void;
  convertSelectedSqlCase: (mode: "upper" | "lower") => void;
  convertSelectedNamingStyle: () => void;
  openDelimitedListDialog: () => void;
  addNextSelectionOccurrenceFromContextMenu: () => void;
  selectAllSelectionOccurrencesFromContextMenu: () => void;
  openFindReplaceFromContextMenu: () => void;
  deleteEmptyLines: () => void;
  selectAllSqlFromContextMenu: () => void;
  emitContextObjectAction: (action: QueryContextObjectAction) => void;
  openCodeSnapshot: () => void;
  sendSelectionToAi: () => void;
}

const props = defineProps<{ getState: () => QueryEditorContextMenuState; actions: QueryEditorContextMenuActions }>();
const emit = defineEmits<{ close: [] }>();
defineSlots<{ default(props: { onContextMenu: (event: MouseEvent) => void; isOpen: boolean }): unknown }>();
const { t } = useI18n();

function contextObjectMenuItem(action: QueryContextObjectAction, target: SqlObjectNavigationTarget | null): ContextMenuItem {
  const disabled = !target;
  switch (action) {
    case "view-data":
      return {
        label: t("contextMenu.viewData"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: Table2,
      };
    case "peek-table-structure":
      return {
        label: t("contextMenu.peekStructure"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: Columns3,
      };
    case "edit-table-structure":
      return {
        label: t("contextMenu.editStructure"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: PencilRuler,
      };
    case "edit-view":
      return {
        label: t("contextMenu.editView"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: Pencil,
      };
    case "view-source":
      return {
        label: t("contextMenu.viewSource"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: Code2,
      };
    case "view-ddl":
      return {
        label: t("contextMenu.viewDdl"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: FileCode,
      };
  }
}

const contextMenuItems = computed<ContextMenuItem[]>(() => {
  const state = props.getState();
  const actions = props.actions;
  const shortcuts = normalizeShortcutSettings(state.shortcuts);
  const canCopySelectedSql = state.selectedSql.length > 0;
  const canExecuteContextSql = state.executableSql.trim().length > 0;
  const executeContextMenuLabel = t(state.selectedSql.trim().length > 0 ? "editor.contextMenu.executeSelection" : "editor.contextMenu.executeCurrent");
  // The menu closes before running its action, so retain this right-click's
  // resolved target instead of reading state after the close handler runs.
  const expandSelectStar = state.expandSelectStar;
  return [
    ...(state.hideExecutionControls
      ? []
      : [
          {
            label: executeContextMenuLabel,
            action: actions.executeFromContextMenu,
            disabled: !canExecuteContextSql,
            icon: Play,
            shortcut: shortcuts.executeSql,
          },
          {
            label: t("settings.shortcutExecuteSqlInNewResultTab"),
            action: actions.executeInNewResultTabFromContextMenu,
            disabled: !canExecuteContextSql,
            icon: Play,
            shortcut: shortcuts.executeSqlInNewResultTab,
          },
          {
            label: t("editor.previewChanges"),
            action: () => void actions.requestPreviewChanges(props.getState().previewContextSql),
            disabled: !state.previewContextSql,
            icon: Eye,
          },
          {
            label: t("editor.contextMenu.export"),
            icon: Download,
            disabled: !canExecuteContextSql,
            children: [
              { label: t("editor.contextMenu.exportQueryResultTo", { format: "CSV" }), action: () => actions.exportQueryFromContextMenu("csv") },
              { label: t("editor.contextMenu.exportQueryResultTo", { format: "XLSX" }), action: () => actions.exportQueryFromContextMenu("xlsx") },
              { label: t("editor.contextMenu.exportQueryResultTo", { format: "TXT" }), action: () => actions.exportQueryFromContextMenu("txt") },
            ],
          },
        ]),
    ...queryContextObjectActions(state.contextObjectTarget?.type).map((action) => contextObjectMenuItem(action, state.contextObjectTarget)),
    {
      label: t("editor.contextMenu.expandSelectStar"),
      action: () => expandSelectStar?.(),
      disabled: !expandSelectStar,
      icon: Table2,
      shortcut: shortcuts.expandSelectStar,
    },
    { label: "", separator: true },
    {
      label: t("editor.contextMenu.commentSelection"),
      action: actions.toggleCommentFromContextMenu,
      disabled: state.readOnly || !canCopySelectedSql,
      icon: MessageSquareText,
      shortcut: shortcuts.toggleLineComment,
    },
    {
      label: t("editor.contextMenu.blockCommentSelection"),
      action: actions.toggleBlockCommentFromContextMenu,
      disabled: state.readOnly || !canCopySelectedSql || !supportsQueryEditorBlockComments(state.databaseType),
      icon: MessageSquareText,
      shortcut: shortcuts.toggleBlockComment,
    },
    {
      label: t("editor.contextMenu.formatSelectionSql"),
      action: () => void actions.formatCurrentSql(),
      disabled: state.readOnly || !canCopySelectedSql || !canFormatSqlForDatabaseType(state.databaseType),
      icon: AlignLeft,
      shortcut: shortcuts.formatSql,
    },
    {
      label: t("editor.contextMenu.compressSelectionSql"),
      action: actions.compressCurrentSql,
      disabled: state.readOnly || !canCopySelectedSql,
      icon: Minimize2,
    },
    {
      label: t("editor.contextMenu.copySelection"),
      action: actions.copySelectedSqlFromContextMenu,
      disabled: !canCopySelectedSql,
      icon: Copy,
      shortcut: "Mod+C",
    },
    {
      label: t("editor.contextMenu.copySelectionAsRichText"),
      action: actions.copySelectedSqlAsRichTextFromContextMenu,
      disabled: !canCopySelectedSql,
      icon: Highlighter,
    },
    {
      label: t("editor.contextMenu.screenshotSelection"),
      action: actions.openCodeSnapshot,
      disabled: !canCopySelectedSql,
      icon: Camera,
    },
    {
      label: t("editor.contextMenu.cutSelection"),
      action: actions.cutSelectedSqlFromContextMenu,
      disabled: !canCopySelectedSql || state.readOnly,
      icon: Scissors,
      shortcut: "Mod+X",
    },
    {
      label: t("editor.contextMenu.pasteFromClipboard"),
      action: actions.pasteClipboardSqlFromContextMenu,
      disabled: state.readOnly,
      icon: ClipboardPaste,
      shortcut: "Mod+V",
    },
    {
      label: t("editor.contextMenu.sendToAi"),
      action: () => {
        actions.sendSelectionToAi();
      },
      disabled: !canCopySelectedSql,
      icon: Sparkles,
      shortcut: shortcuts.sendSelectionToAi,
    },
    {
      label: t("editor.contextMenu.uppercaseSelection"),
      action: () => actions.convertSelectedSqlCase("upper"),
      disabled: !canCopySelectedSql,
      icon: CaseUpper,
      shortcut: shortcuts.uppercaseSelection,
    },
    {
      label: t("editor.contextMenu.lowercaseSelection"),
      action: () => actions.convertSelectedSqlCase("lower"),
      disabled: !canCopySelectedSql,
      icon: CaseLower,
      shortcut: shortcuts.lowercaseSelection,
    },
    {
      label: t("editor.contextMenu.convertNamingStyle"),
      action: actions.convertSelectedNamingStyle,
      disabled: !canCopySelectedSql,
      icon: CaseSensitive,
      shortcut: shortcuts.convertNamingStyle,
    },
    {
      label: t("editor.contextMenu.delimitedList"),
      action: actions.openDelimitedListDialog,
      disabled: state.readOnly || !canCopySelectedSql,
      icon: List,
    },
    {
      label: t("editor.contextMenu.addNextSelectionOccurrence"),
      action: actions.addNextSelectionOccurrenceFromContextMenu,
      icon: TextSelect,
      shortcut: shortcuts.addNextSelectionOccurrence,
    },
    {
      label: t("editor.contextMenu.selectAllSelectionOccurrences"),
      action: actions.selectAllSelectionOccurrencesFromContextMenu,
      icon: TextSelect,
      shortcut: shortcuts.selectAllSelectionOccurrences,
    },
    { label: "", separator: true },
    {
      label: t("editor.contextMenu.findReplace"),
      action: actions.openFindReplaceFromContextMenu,
      icon: Search,
      shortcut: shortcuts.find,
    },
    {
      label: t("editor.contextMenu.deleteEmptyLines"),
      action: actions.deleteEmptyLines,
      disabled: state.readOnly,
      icon: Trash2,
    },
    { label: "", separator: true },
    {
      label: t("editor.contextMenu.selectAll"),
      action: actions.selectAllSqlFromContextMenu,
      icon: TextSelect,
      shortcut: shortcuts.selectAll,
    },
  ];
});

function currentContextMenuItems(): ContextMenuItem[] {
  return contextMenuItems.value;
}
</script>

<template>
  <CustomContextMenu :items="currentContextMenuItems" @close="emit('close')" v-slot="slotProps">
    <slot v-bind="slotProps" />
  </CustomContextMenu>
</template>
