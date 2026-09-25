<script setup lang="ts">
import { applyDdlStoragePreference } from "@/lib/sql/ddlStorage";
import DdlStorageToggle from "@/components/objects/DdlStorageToggle.vue";
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Clipboard, ExternalLink, Loader2, RefreshCw } from "@lucide/vue";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { loadEditorTheme, editorFontTheme } from "@/lib/editor/editorThemes";
import { editorClipboardLineEndingsExtension } from "@/lib/editor/editorClipboardLineEndings";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { ddlFormatDialectFor, formatDdlForDisplay } from "@/lib/sql/ddlDisplay";
import { loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import { useQueryStore } from "@/stores/queryStore";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { HelpTooltip } from "@/components/ui/tooltip";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";
import type { EditorView } from "@codemirror/view";
import type { DatabaseType, ObjectSourceKind } from "@/types/database";

const props = withDefaults(
  defineProps<{
    open: boolean;
    connectionId: string;
    database: string;
    catalog?: string;
    schema?: string;
    tableName: string;
    objectType?: ObjectSourceKind;
    /** Effective database type selects database-specific syntax rules; older callers can still rely on the dialect fallback. */
    databaseType?: DatabaseType;
    /** SQL dialect fallback for syntax highlighting when the effective database type is unavailable. */
    dialect: "mysql" | "postgres" | "sqlserver";
    /** SQL formatter dialect. Kept separate from the syntax-highlighting dialect because several PG-compatible DBs highlight as MySQL. */
    formatDialect?: SqlFormatDialect;
  }>(),
  {},
);

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const { t } = useI18n();
const { toast } = useToast();
const { isDark, themePalette } = useTheme();
const settingsStore = useSettingsStore();

const originalDdlContent = ref("");
const formattedDdlContent = ref("");
const ddlDisplayMode = ref<"formatted" | "original">("formatted");
const ddlContent = computed(() => applyDdlStoragePreference(ddlDisplayMode.value === "formatted" ? formattedDdlContent.value : originalDdlContent.value, props.databaseType, settingsStore.editorSettings.excludeDdlStorage));
const ddlLoading = ref(false);
const ddlError = ref("");
const ddlEditorContainer = ref<HTMLDivElement>();
const ddlSearchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const ddlEditorView = shallowRef<EditorView | null>(null);
let ddlEditorResizeObserver: ResizeObserver | null = null;

// Keep the dialog movable for the duration of one open cycle. This mirrors the
// existing draggable dialogs without persisting a potentially off-screen position.
const dragOffset = ref({ x: 0, y: 0 });
const isDragging = ref(false);
const dragStartPosition = ref({ x: 0, y: 0 });
const dragStartOffset = ref({ x: 0, y: 0 });
const activePointerId = ref<number | null>(null);
const dialogSize = ref({ width: 980, height: 720 });
const isResizing = ref(false);
const resizeStartPosition = ref({ x: 0, y: 0 });
const resizeStartSize = ref({ width: 980, height: 720 });
const resizeStartOffset = ref({ x: 0, y: 0 });
const resizeStartRect = ref({ left: 0, top: 0 });
const activeResizePointerId = ref<number | null>(null);
const dialogContentStyle = computed(() => {
  const moved = isDragging.value || dragOffset.value.x !== 0 || dragOffset.value.y !== 0;
  return {
    width: `min(${dialogSize.value.width}px, calc(100vw - 32px))`,
    height: `min(${dialogSize.value.height}px, calc(100vh - 32px))`,
    maxWidth: "calc(100vw - 32px)",
    maxHeight: "calc(100vh - 32px)",
    minWidth: "min(560px, calc(100vw - 32px))",
    minHeight: "min(420px, calc(100vh - 32px))",
    transform: moved ? `translate(${dragOffset.value.x}px, ${dragOffset.value.y}px)` : undefined,
    transition: isDragging.value || isResizing.value ? "none" : "transform 0.15s ease-out",
  };
});

// The CodeMirror editor (if any) that was focused when this dialog opened, so focus can be
// restored to it on close. Not a ref: read/written outside of render, never needs reactivity.
let editorRootToRestoreFocus: HTMLElement | null = null;

function resetDialogDragOffset() {
  dragOffset.value = { x: 0, y: 0 };
  isDragging.value = false;
  activePointerId.value = null;
  dialogSize.value = { width: 980, height: 720 };
  isResizing.value = false;
  activeResizePointerId.value = null;
}

function startDialogDrag(event: PointerEvent) {
  if (event.button !== undefined && event.button !== 0) return;
  isDragging.value = true;
  activePointerId.value = event.pointerId;
  dragStartPosition.value = { x: event.clientX, y: event.clientY };
  dragStartOffset.value = { ...dragOffset.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveDialogDrag(event: PointerEvent) {
  if (!isDragging.value || event.pointerId !== activePointerId.value) return;
  dragOffset.value = {
    x: dragStartOffset.value.x + event.clientX - dragStartPosition.value.x,
    y: dragStartOffset.value.y + event.clientY - dragStartPosition.value.y,
  };
}

function endDialogDrag(event: PointerEvent) {
  if (!isDragging.value || event.pointerId !== activePointerId.value) return;
  isDragging.value = false;
  activePointerId.value = null;
  try {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture may already have been released by the browser.
  }
}

function startDialogResize(event: PointerEvent) {
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  isResizing.value = true;
  activeResizePointerId.value = event.pointerId;
  resizeStartPosition.value = { x: event.clientX, y: event.clientY };
  const dialogRect = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-slot='dialog-content']")?.getBoundingClientRect();
  resizeStartSize.value = dialogRect ? { width: dialogRect.width, height: dialogRect.height } : { ...dialogSize.value };
  resizeStartRect.value = dialogRect ? { left: dialogRect.left, top: dialogRect.top } : { left: 0, top: 0 };
  resizeStartOffset.value = { ...dragOffset.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveDialogResize(event: PointerEvent) {
  if (!isResizing.value || event.pointerId !== activeResizePointerId.value) return;
  const maxWidth = Math.max(1, Math.min(window.innerWidth - 32, window.innerWidth - 16 - resizeStartRect.value.left));
  const maxHeight = Math.max(1, Math.min(window.innerHeight - 32, window.innerHeight - 16 - resizeStartRect.value.top));
  const minWidth = Math.min(560, maxWidth);
  const minHeight = Math.min(420, maxHeight);
  const width = Math.min(maxWidth, Math.max(minWidth, resizeStartSize.value.width + event.clientX - resizeStartPosition.value.x));
  const height = Math.min(maxHeight, Math.max(minHeight, resizeStartSize.value.height + event.clientY - resizeStartPosition.value.y));
  dialogSize.value = { width, height };
  dragOffset.value = {
    x: resizeStartOffset.value.x + (width - resizeStartSize.value.width) / 2,
    y: resizeStartOffset.value.y + (height - resizeStartSize.value.height) / 2,
  };
}

function endDialogResize(event: PointerEvent) {
  if (!isResizing.value || event.pointerId !== activeResizePointerId.value) return;
  isResizing.value = false;
  activeResizePointerId.value = null;
  try {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture may already have been released by the browser.
  }
}

async function loadDdl(force = false) {
  ddlError.value = "";
  ddlLoading.value = true;
  if (force) destroyDdlEditor();
  try {
    const schema = props.schema || props.database;
    const { ddl } = await loadObjectDdl(
      {
        connectionId: props.connectionId,
        database: props.database,
        schema,
        tableName: props.tableName,
        objectType: props.objectType,
        catalog: props.catalog,
      },
      { force },
    );
    const formatDialect = ddlFormatDialectFor({ formatDialect: props.formatDialect, databaseType: props.databaseType, highlightDialect: props.dialect });
    originalDdlContent.value = ddl;
    formattedDdlContent.value = await formatDdlForDisplay(
      ddl,
      {
        dialect: formatDialect,
        databaseType: props.databaseType,
        database: props.database,
        catalog: props.catalog,
        includeDatabaseName: settingsStore.editorSettings.generateSqlIncludeDatabaseName,
        quoteIdentifiers: settingsStore.editorSettings.generateSqlQuoteIdentifiers,
      },
      settingsStore.editorSettings.sqlFormatter,
    );
  } catch (e: any) {
    ddlError.value = e?.message || String(e);
  } finally {
    ddlLoading.value = false;
  }
}

/** Loads from the persisted snapshot by default; users can opt into a fresh database query on every open. */
watch(
  () => props.open,
  async (open) => {
    resetDialogDragOffset();
    if (!open) return;
    const active = document.activeElement;
    editorRootToRestoreFocus = active instanceof HTMLElement ? active.closest(".cm-editor") : null;
    ddlDisplayMode.value = "formatted";
    originalDdlContent.value = "";
    formattedDdlContent.value = "";
    if (settingsStore.editorSettings.ddlOpenMode === "tab") {
      openDdlViewerTabPending();
      return;
    }
    await loadDdl(settingsStore.editorSettings.refreshDdlOnOpen);
  },
  { immediate: true },
);

/**
 * Restores focus through CodeMirror's own `EditorView.focus()` instead of the browser default.
 *
 * Radix's default close-auto-focus calls the plain DOM `.focus()` on whatever was focused before
 * the dialog opened. In WebKit (the desktop app's webview on macOS), refocusing a contenteditable
 * this way resets its caret to the very start of the document; CodeMirror then treats that as a
 * real selection change and scrolls to follow it, snapping a long query editor to the top (#6067).
 * `EditorView.focus()` avoids this by suppressing its own selection observer while it restores the
 * DOM selection to match its actual (unmoved) internal state.
 */
function onDdlDialogCloseAutoFocus(event: Event) {
  const target = editorRootToRestoreFocus;
  editorRootToRestoreFocus = null;
  if (!target || !target.isConnected) return;
  event.preventDefault();
  void import("@codemirror/view").then(({ EditorView }) => {
    EditorView.findFromDOM(target)?.focus();
  });
}

/**
 * Creates a lightweight read-only CodeMirror editor inside the dialog.
 *
 * Follows the same pattern as QueryEditor:
 * - cmSearch with hidden createPanel replaces the default search UI,
 *   so EditorSearchPanel is the only visible search panel.
 * - Prec.highest overrides Cmd+F to open EditorSearchPanel.
 * - Editor theme/font are loaded from user settings for consistent appearance.
 */
async function initDdlEditor(content: string) {
  if (!ddlEditorContainer.value) return;
  destroyDdlEditor();
  const [{ EditorView, keymap }, { EditorState, Prec }, langSql, { basicSetup }, { search: cmSearch }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("codemirror"), import("@codemirror/search")]);
  const editorTheme = settingsStore.editorSettings.theme;
  const appAppearance = isDark.value ? "dark" : "light";
  const fontSize = settingsStore.editorSettings.fontSize;
  const fontFamily = settingsStore.editorSettings.fontFamily;
  const themeExt = await loadEditorTheme(editorTheme, appAppearance, undefined, themePalette.value);
  const fontExt = editorFontTheme(EditorView, fontSize, fontFamily, { fixedHeight: true, scrollable: true });
  const dialect = createDbxCodeMirrorSqlDialect(langSql, props.dialect, props.databaseType);
  const state = EditorState.create({
    doc: content,
    extensions: [
      // Enable search functionality but hide the default panel —
      // EditorSearchPanel provides the visible search UI instead, same as QueryEditor.
      cmSearch({
        top: true,
        createPanel: () => {
          const dom = document.createElement("span");
          dom.style.display = "none";
          return { dom };
        },
      }),
      basicSetup,
      editorClipboardLineEndingsExtension(EditorView),
      EditorState.allowMultipleSelections.of(true),
      langSql.sql({ dialect }),
      themeExt,
      fontExt,
      // Intercept Cmd+F at highest precedence so EditorSearchPanel opens
      // instead of the default search panel (which is hidden above).
      Prec.highest(keymap.of([{ key: "Mod-f", run: () => ddlSearchPanelRef.value?.openSearch() ?? false, preventDefault: true }])),
      // Remove CodeMirror's default 1px dotted focus outline,
      // which is visible below the content when the DDL is short.
      EditorView.theme({
        "&.cm-focused": { outline: "none" },
        ".cm-content": {
          cursor: "text",
          userSelect: "text",
          WebkitUserSelect: "text",
        },
        ".cm-line": {
          userSelect: "text",
          WebkitUserSelect: "text",
        },
      }),
      EditorState.readOnly.of(true),
    ],
  });
  const editorView = new EditorView({ state, parent: ddlEditorContainer.value });
  ddlEditorView.value = editorView;
  if (typeof ResizeObserver !== "undefined") {
    ddlEditorResizeObserver = new ResizeObserver(() => editorView.requestMeasure());
    ddlEditorResizeObserver.observe(ddlEditorContainer.value);
  }
  editorView.focus();
}

/** Tears down the CodeMirror instance when the dialog closes. */
function destroyDdlEditor() {
  ddlEditorResizeObserver?.disconnect();
  ddlEditorResizeObserver = null;
  ddlEditorView.value?.destroy();
  ddlEditorView.value = null;
}

/** Copies the DDL text to clipboard. */
function copyDdlContent() {
  if (ddlContent.value) {
    copyToClipboard(ddlContent.value);
    toast(t("contextMenu.ddlCopied"), 2000);
  }
}

/**
 * Creates the read-only DDL tab. With `ddl` empty the tab is created pending
 * (`ddlLoad`) and loads through the tab surface itself — the same "tab first,
 * load with visible state" flow as object-source tabs — so in tab mode the
 * click shows the tab and its loading state immediately instead of silently
 * waiting behind a closed dialog; a failure is shown in place with a retry.
 */
function createDdlViewerTab(ddl: string, pending: boolean) {
  const queryStore = useQueryStore();
  const tabId = queryStore.createTab(props.connectionId, props.database, `${t("contextMenu.viewDdl")} - ${props.tableName}`, "query", props.schema, ddl, props.catalog, { forceNew: true, sourceView: true });
  const tab = queryStore.tabs.find((item) => item.id === tabId);
  if (tab) {
    tab.ddlViewer = {
      schema: props.schema || props.database,
      tableName: props.tableName,
      objectType: props.objectType,
      formatDialect: ddlFormatDialectFor({ formatDialect: props.formatDialect, databaseType: props.databaseType, highlightDialect: props.dialect }),
    };
    if (pending) {
      tab.ddlLoad = { startedAt: Date.now() };
      void queryStore.loadDdlViewerTab(tabId);
    }
  }
  onClose();
}

function openDdlInNewTab() {
  const ddl = ddlContent.value.trim();
  if (!ddl) return;

  createDdlViewerTab(ddl, false);
}

function openDdlViewerTabPending() {
  createDdlViewerTab("", true);
}

watch(ddlContent, (content) => {
  const view = ddlEditorView.value;
  if (view) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
});

// When DDL finishes loading, create the editor inside the dialog.
watch([ddlLoading, ddlContent], ([loading, content]) => {
  if (!loading && content && props.open) {
    nextTick(() => {
      if (!ddlLoading.value && props.open && ddlContent.value === content) void initDdlEditor(content);
    });
  }
});

// Destroy CodeMirror when the dialog hides, so the editor's event listeners
// and DOM aren't consuming resources while the dialog is closed.
// The editor is re-created on next open via the ddlLoading watch.
watch(
  () => props.open,
  (open) => {
    if (!open) destroyDdlEditor();
  },
);

// Safety net: destroy editor when component eventually unmounts.
onUnmounted(() => {
  destroyDdlEditor();
});

function retry() {
  originalDdlContent.value = "";
  formattedDdlContent.value = "";
  ddlDisplayMode.value = "formatted";
  void loadDdl(true);
}

function setRefreshDdlOnOpen(value: boolean) {
  settingsStore.updateEditorSettings({ refreshDdlOnOpen: value });
  if (value) void loadDdl(true);
}

function setDdlOpenMode(value: unknown) {
  if (value === "dialog" || value === "tab") settingsStore.updateEditorSettings({ ddlOpenMode: value });
}

function onClose() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="props.open" @update:open="onClose">
    <DialogContent :style="dialogContentStyle" class="dbx-ddl-view-dialog flex min-h-0 flex-col overflow-hidden sm:max-w-190" @close-auto-focus="onDdlDialogCloseAutoFocus">
      <DialogHeader class="shrink-0 cursor-move select-none" @pointerdown="startDialogDrag" @pointermove="moveDialogDrag" @pointerup="endDialogDrag" @pointercancel="endDialogDrag">
        <DialogTitle>DDL - {{ props.tableName }}</DialogTitle>
      </DialogHeader>
      <div class="flex min-h-0 flex-1 flex-col gap-3">
        <div v-if="!ddlLoading && !ddlError && ddlContent" class="flex shrink-0 items-center justify-between gap-3">
          <span class="text-sm text-muted-foreground">{{ t("contextMenu.ddlDisplayMode") }}</span>
          <div class="flex items-center gap-1" role="group" :aria-label="t('contextMenu.ddlDisplayMode')">
            <Button variant="outline" size="sm" :class="ddlDisplayMode === 'formatted' ? 'border-primary bg-accent' : ''" :aria-pressed="ddlDisplayMode === 'formatted'" @click="ddlDisplayMode = 'formatted'">
              {{ t("contextMenu.ddlDisplayFormatted") }}
            </Button>
            <Button variant="outline" size="sm" :class="ddlDisplayMode === 'original' ? 'border-primary bg-accent' : ''" :aria-pressed="ddlDisplayMode === 'original'" @click="ddlDisplayMode = 'original'">
              {{ t("contextMenu.ddlDisplayOriginal") }}
            </Button>
          </div>
        </div>
        <div v-if="ddlLoading" class="flex min-h-80 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          <span>{{ t("contextMenu.viewDdlLoading") }}</span>
        </div>
        <div v-else-if="ddlError" class="flex min-h-80 flex-1 flex-col items-center justify-center gap-3 text-sm">
          <p class="text-destructive">{{ ddlError }}</p>
          <Button variant="outline" size="sm" @click="retry">
            <RefreshCw />
            {{ t("common.retry") }}
          </Button>
        </div>
        <div v-else class="ddl-view-editor relative min-h-0 flex-1 overflow-hidden rounded border">
          <div ref="ddlEditorContainer" class="h-full" />
          <EditorSearchPanel v-if="ddlEditorView" ref="ddlSearchPanelRef" :view="ddlEditorView" />
        </div>
      </div>
      <DdlStorageToggle :database-type="props.databaseType" :disabled="ddlLoading || !!ddlError" />
      <DialogFooter class="shrink-0 pr-7">
        <div class="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
          <Switch id="ddl-refresh-on-open" size="sm" :model-value="settingsStore.editorSettings.refreshDdlOnOpen" @update:model-value="setRefreshDdlOnOpen" />
          <div class="flex items-center gap-1">
            <label for="ddl-refresh-on-open" class="cursor-pointer">{{ t("contextMenu.refreshDdlOnOpen") }}</label>
            <HelpTooltip :label="t('contextMenu.refreshDdlOnOpenHint')" trigger-class="[&_svg]:h-3 [&_svg]:w-3">
              {{ t("contextMenu.refreshDdlOnOpenHint") }}
            </HelpTooltip>
          </div>
          <span class="ml-3">{{ t("contextMenu.ddlOpenMode") }}</span>
          <Select :model-value="settingsStore.editorSettings.ddlOpenMode" @update:model-value="setDdlOpenMode">
            <SelectTrigger class="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dialog">{{ t("contextMenu.ddlOpenModeDialog") }}</SelectItem>
              <SelectItem value="tab">{{ t("contextMenu.ddlOpenModeTab") }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" @click="onClose">{{ t("common.close") }}</Button>
        <Button variant="outline" :disabled="ddlLoading || !ddlContent" :title="t('contextMenu.openDdlInNewTab')" @click="openDdlInNewTab">
          <ExternalLink class="h-4 w-4" />
          {{ t("contextMenu.openDdlInNewTab") }}
        </Button>
        <Button variant="outline" :disabled="ddlLoading" :title="t('structureEditor.refresh')" @click="loadDdl(true)">
          <RefreshCw class="h-4 w-4" />
          {{ t("structureEditor.refresh") }}
        </Button>
        <Button variant="outline" :disabled="!ddlContent" @click="copyDdlContent">
          <Clipboard class="h-4 w-4" />
          {{ t("grid.copyDdl") }}
        </Button>
      </DialogFooter>
      <button
        type="button"
        class="absolute bottom-1 right-1 z-20 grid size-6 touch-none cursor-nwse-resize place-items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :aria-label="t('contextMenu.resizeDdlDialog')"
        @pointerdown="startDialogResize"
        @pointermove="moveDialogResize"
        @pointerup="endDialogResize"
        @pointercancel="endDialogResize"
      >
        <span aria-hidden="true" class="h-3 w-3 border-b-2 border-r-2 border-current" />
      </button>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.ddl-view-editor :deep(.cm-content),
.ddl-view-editor :deep(.cm-line) {
  cursor: text;
  user-select: text !important;
  -webkit-user-select: text !important;
}

.ddl-view-editor :deep(.cm-selectionBackground),
.ddl-view-editor :deep(.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35)) !important;
}

.ddl-view-editor :deep(.cm-content ::selection) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35)) !important;
}
</style>
