<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  AlignLeft,
  ArrowDownUp,
  Camera,
  CaseLower,
  CaseSensitive,
  CaseUpper,
  ChevronsUpDown,
  ClipboardPaste,
  Code2,
  Columns3,
  Download,
  Eye,
  FileCode,
  FoldVertical,
  GitBranch,
  Highlighter,
  MessageSquareText,
  Minimize2,
  Pencil,
  PencilRuler,
  Play,
  Copy,
  List,
  Scissors,
  Search,
  Sparkles,
  Table2,
  TextSelect,
  Trash2,
  UnfoldVertical,
  WandSparkles,
} from "@lucide/vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { canFormatSqlForDatabaseType } from "@/lib/sql/sqlFormatter";
import { supportsQueryEditorBlockComments } from "@/lib/database/databaseFeatureSupport";
import { normalizeShortcutSettings, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";
import { queryContextObjectActions, type QueryContextObjectAction } from "@/lib/sql/queryCursorTableTarget";
import type { SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import type { SqlSelectionCaseMode } from "@/lib/sql/sqlSelectionCase";
import type { QueryEditorProps } from "./queryEditorTypes";
import { useSidebarMenuPresentation } from "@/composables/useSidebarMenuPresentation";

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
  canExplain?: boolean;
  hasContent?: boolean;
}

export interface QueryEditorContextMenuActions {
  executeFromContextMenu: () => void;
  executeInNewResultTabFromContextMenu: () => void;
  explainFromContextMenu?: () => void;
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
  pasteClipboardSqlRestoringSource: () => void;
  convertSelectedSqlCase: (mode: SqlSelectionCaseMode) => void;
  convertSelectedNamingStyle: () => void;
  openDelimitedListDialog: () => void;
  addNextSelectionOccurrenceFromContextMenu: () => void;
  selectAllSelectionOccurrencesFromContextMenu: () => void;
  openFindReplaceFromContextMenu: () => void;
  deleteEmptyLines: () => void;
  selectCurrentStatementFromContextMenu: () => void;
  selectAllSqlFromContextMenu: () => void;
  emitContextObjectAction: (action: QueryContextObjectAction) => void;
  openCodeSnapshot: () => void;
  sendSelectionToAi: () => void;
  toggleFoldFromContextMenu?: () => void;
  foldAllFromContextMenu?: () => void;
  unfoldAllFromContextMenu?: () => void;
}

const props = defineProps<{ getState: () => QueryEditorContextMenuState; actions: QueryEditorContextMenuActions }>();
const emit = defineEmits<{ close: [] }>();
defineSlots<{ default(props: { onContextMenu: (event: MouseEvent) => void; isOpen: boolean }): unknown }>();
const { t } = useI18n();
const { presentMenu, SidebarMenuPreferencesDialog, sidebarMenuPreferencesOpen, sidebarMenuPreferences } = useSidebarMenuPresentation();

function contextObjectMenuItem(action: QueryContextObjectAction, target: SqlObjectNavigationTarget | null): ContextMenuItem {
  const disabled = !target;
  switch (action) {
    case "view-data":
      return {
        sidebarActionId: `editor.object.${action}`,
        label: t("contextMenu.viewData"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: Table2,
      };
    case "peek-table-structure":
      return {
        sidebarActionId: `editor.object.${action}`,
        label: t("contextMenu.peekStructure"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: Columns3,
      };
    case "edit-table-structure":
      return {
        sidebarActionId: `editor.object.${action}`,
        label: t("contextMenu.editStructure"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: PencilRuler,
      };
    case "edit-view":
      return {
        sidebarActionId: `editor.object.${action}`,
        label: t("contextMenu.editView"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: Pencil,
      };
    case "view-source":
      return {
        sidebarActionId: `editor.object.${action}`,
        label: t("contextMenu.viewSource"),
        action: () => props.actions.emitContextObjectAction(action),
        disabled,
        icon: Code2,
      };
    case "view-ddl":
      return {
        sidebarActionId: `editor.object.${action}`,
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
            sidebarActionId: "editor.execute",
            label: executeContextMenuLabel,
            action: actions.executeFromContextMenu,
            disabled: !canExecuteContextSql,
            icon: Play,
            shortcut: shortcuts.executeSql,
          },
          {
            sidebarActionId: "settings.shortcutExecuteSqlInNewResultTab",
            label: t("settings.shortcutExecuteSqlInNewResultTab"),
            action: actions.executeInNewResultTabFromContextMenu,
            disabled: !canExecuteContextSql,
            icon: Play,
            shortcut: shortcuts.executeSqlInNewResultTab,
          },
          {
            sidebarActionId: "toolbar.explainPlan",
            label: t("toolbar.explainPlan"),
            action: actions.explainFromContextMenu,
            disabled: state.canExplain === false || !canExecuteContextSql,
            icon: GitBranch,
            shortcut: shortcuts.explainSql,
          },
          {
            sidebarActionId: "editor.previewChanges",
            label: t("editor.previewChanges"),
            action: () => void actions.requestPreviewChanges(props.getState().previewContextSql),
            disabled: !state.previewContextSql,
            icon: Eye,
          },
          {
            sidebarActionId: "editor.contextMenu.export",
            label: t("editor.contextMenu.export"),
            icon: Download,
            disabled: !canExecuteContextSql,
            children: [
              { sidebarActionId: "editor.contextMenu.exportQueryResultTo", label: t("editor.contextMenu.exportQueryResultTo", { format: "CSV" }), action: () => actions.exportQueryFromContextMenu("csv") },
              { sidebarActionId: "editor.contextMenu.exportQueryResultTo", label: t("editor.contextMenu.exportQueryResultTo", { format: "XLSX" }), action: () => actions.exportQueryFromContextMenu("xlsx") },
              { sidebarActionId: "editor.contextMenu.exportQueryResultTo", label: t("editor.contextMenu.exportQueryResultTo", { format: "TXT" }), action: () => actions.exportQueryFromContextMenu("txt") },
            ],
          },
        ]),
    ...queryContextObjectActions(state.contextObjectTarget?.type).map((action) => contextObjectMenuItem(action, state.contextObjectTarget)),
    {
      sidebarActionId: "editor.contextMenu.expandSelectStar",
      label: t("editor.contextMenu.expandSelectStar"),
      action: () => expandSelectStar?.(),
      disabled: !expandSelectStar,
      icon: Table2,
      shortcut: shortcuts.expandSelectStar,
    },
    { label: "", separator: true },
    {
      sidebarActionId: "editor.contextMenu.commentSelection",
      label: t("editor.contextMenu.commentSelection"),
      action: actions.toggleCommentFromContextMenu,
      disabled: state.readOnly || !canCopySelectedSql,
      icon: MessageSquareText,
      shortcut: shortcuts.toggleLineComment,
    },
    {
      sidebarActionId: "editor.contextMenu.blockCommentSelection",
      label: t("editor.contextMenu.blockCommentSelection"),
      action: actions.toggleBlockCommentFromContextMenu,
      disabled: state.readOnly || !canCopySelectedSql || !supportsQueryEditorBlockComments(state.databaseType),
      icon: MessageSquareText,
      shortcut: shortcuts.toggleBlockComment,
    },
    {
      sidebarActionId: "editor.format",
      label: canCopySelectedSql ? t("editor.contextMenu.formatSelectionSql") : t("toolbar.formatSql"),
      action: () => void actions.formatCurrentSql(),
      disabled: state.readOnly || (!canCopySelectedSql && !canExecuteContextSql && !state.hasContent) || !canFormatSqlForDatabaseType(state.databaseType),
      icon: AlignLeft,
      shortcut: shortcuts.formatSql,
    },
    {
      sidebarActionId: "editor.contextMenu.compressSelectionSql",
      label: t("editor.contextMenu.compressSelectionSql"),
      action: actions.compressCurrentSql,
      disabled: state.readOnly || !canCopySelectedSql,
      icon: Minimize2,
    },
    {
      sidebarActionId: "editor.contextMenu.folding",
      label: t("editor.contextMenu.folding"),
      icon: ChevronsUpDown,
      children: [
        {
          sidebarActionId: "editor.contextMenu.toggleFold",
          label: t("editor.contextMenu.toggleFold"),
          action: () => actions.toggleFoldFromContextMenu?.(),
          icon: ChevronsUpDown,
          shortcut: shortcuts.toggleFold,
        },
        {
          sidebarActionId: "editor.contextMenu.foldAll",
          label: t("editor.contextMenu.foldAll"),
          action: () => actions.foldAllFromContextMenu?.(),
          icon: FoldVertical,
          shortcut: shortcuts.foldAll,
        },
        {
          sidebarActionId: "editor.contextMenu.unfoldAll",
          label: t("editor.contextMenu.unfoldAll"),
          action: () => actions.unfoldAllFromContextMenu?.(),
          icon: UnfoldVertical,
          shortcut: shortcuts.unfoldAll,
        },
      ],
    },
    {
      sidebarActionId: "editor.contextMenu.copySelection",
      label: t("editor.contextMenu.copySelection"),
      action: actions.copySelectedSqlFromContextMenu,
      disabled: !canCopySelectedSql,
      icon: Copy,
      shortcut: "Mod+C",
    },
    {
      sidebarActionId: "editor.contextMenu.copySelectionAsRichText",
      label: t("editor.contextMenu.copySelectionAsRichText"),
      action: actions.copySelectedSqlAsRichTextFromContextMenu,
      disabled: !canCopySelectedSql,
      icon: Highlighter,
    },
    {
      sidebarActionId: "editor.contextMenu.screenshotSelection",
      label: t("editor.contextMenu.screenshotSelection"),
      action: actions.openCodeSnapshot,
      disabled: !canCopySelectedSql,
      icon: Camera,
    },
    {
      sidebarActionId: "editor.contextMenu.cutSelection",
      label: t("editor.contextMenu.cutSelection"),
      action: actions.cutSelectedSqlFromContextMenu,
      disabled: !canCopySelectedSql || state.readOnly,
      icon: Scissors,
      shortcut: "Mod+X",
    },
    {
      sidebarActionId: "editor.contextMenu.pasteFromClipboard",
      label: t("editor.contextMenu.pasteFromClipboard"),
      action: actions.pasteClipboardSqlFromContextMenu,
      disabled: state.readOnly,
      icon: ClipboardPaste,
      shortcut: "Mod+V",
    },
    {
      // 显式入口：即使关闭了「粘贴时自动还原源码 SQL」设置也能使用
      sidebarActionId: "editor.contextMenu.pasteRestoringSourceSql",
      label: t("editor.contextMenu.pasteRestoringSourceSql"),
      action: actions.pasteClipboardSqlRestoringSource,
      disabled: state.readOnly,
      icon: WandSparkles,
    },
    {
      sidebarActionId: "editor.contextMenu.sendToAi",
      label: t("editor.contextMenu.sendToAi"),
      action: () => {
        actions.sendSelectionToAi();
      },
      disabled: !canCopySelectedSql,
      icon: Sparkles,
      shortcut: shortcuts.sendSelectionToAi,
    },
    {
      sidebarActionId: "editor.contextMenu.toggleCaseSelection",
      label: t("editor.contextMenu.toggleCaseSelection"),
      action: () => actions.convertSelectedSqlCase("toggle"),
      disabled: !canCopySelectedSql,
      icon: ArrowDownUp,
      shortcut: shortcuts.toggleCaseSelection,
    },
    {
      sidebarActionId: "editor.contextMenu.uppercaseSelection",
      label: t("editor.contextMenu.uppercaseSelection"),
      action: () => actions.convertSelectedSqlCase("upper"),
      disabled: !canCopySelectedSql,
      icon: CaseUpper,
      shortcut: shortcuts.uppercaseSelection,
    },
    {
      sidebarActionId: "editor.contextMenu.lowercaseSelection",
      label: t("editor.contextMenu.lowercaseSelection"),
      action: () => actions.convertSelectedSqlCase("lower"),
      disabled: !canCopySelectedSql,
      icon: CaseLower,
      shortcut: shortcuts.lowercaseSelection,
    },
    {
      sidebarActionId: "editor.contextMenu.convertNamingStyle",
      label: t("editor.contextMenu.convertNamingStyle"),
      action: actions.convertSelectedNamingStyle,
      disabled: !canCopySelectedSql,
      icon: CaseSensitive,
      shortcut: shortcuts.convertNamingStyle,
    },
    {
      sidebarActionId: "editor.contextMenu.delimitedList",
      label: t("editor.contextMenu.delimitedList"),
      action: actions.openDelimitedListDialog,
      disabled: state.readOnly || !canCopySelectedSql,
      icon: List,
    },
    {
      sidebarActionId: "editor.contextMenu.addNextSelectionOccurrence",
      label: t("editor.contextMenu.addNextSelectionOccurrence"),
      action: actions.addNextSelectionOccurrenceFromContextMenu,
      icon: TextSelect,
      shortcut: shortcuts.addNextSelectionOccurrence,
    },
    {
      sidebarActionId: "editor.contextMenu.selectAllSelectionOccurrences",
      label: t("editor.contextMenu.selectAllSelectionOccurrences"),
      action: actions.selectAllSelectionOccurrencesFromContextMenu,
      icon: TextSelect,
      shortcut: shortcuts.selectAllSelectionOccurrences,
    },
    {
      sidebarActionId: "editor.contextMenu.selectCurrentStatement",
      label: t("editor.contextMenu.selectCurrentStatement"),
      action: actions.selectCurrentStatementFromContextMenu,
      icon: TextSelect,
      shortcut: shortcuts.selectCurrentStatement,
    },
    { label: "", separator: true },
    {
      sidebarActionId: "editor.contextMenu.findReplace",
      label: t("editor.contextMenu.findReplace"),
      action: actions.openFindReplaceFromContextMenu,
      icon: Search,
      shortcut: shortcuts.find,
    },
    {
      sidebarActionId: "editor.contextMenu.deleteEmptyLines",
      label: t("editor.contextMenu.deleteEmptyLines"),
      action: actions.deleteEmptyLines,
      disabled: state.readOnly,
      icon: Trash2,
    },
    { label: "", separator: true },
    {
      sidebarActionId: "editor.contextMenu.selectAll",
      label: t("editor.contextMenu.selectAll"),
      action: actions.selectAllSqlFromContextMenu,
      icon: TextSelect,
      shortcut: shortcuts.selectAll,
    },
  ];
});

function currentContextMenuItems(): ContextMenuItem[] {
  return presentMenu(contextMenuItems.value, "sql-editor");
}
</script>

<template>
  <CustomContextMenu :items="currentContextMenuItems" @close="emit('close')" v-slot="slotProps">
    <slot v-bind="slotProps" />
  </CustomContextMenu>
  <SidebarMenuPreferencesDialog v-if="sidebarMenuPreferences" v-model:open="sidebarMenuPreferencesOpen" :scope="sidebarMenuPreferences.scope" :items="sidebarMenuPreferences.items" />
</template>
