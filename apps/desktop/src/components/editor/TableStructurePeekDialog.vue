<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { GripVertical, KeyRound, Loader2, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMetadataColumnTypeLabel } from "@/lib/dataGrid/dataGridColumnType";
import { STRUCTURE_PEEK_MIN_HEIGHT, STRUCTURE_PEEK_MIN_WIDTH, centeredStructurePeekRect, clampStructurePeekRect, defaultStructurePeekSize, resizeStructurePeekRect, type StructurePeekResizeEdge } from "@/lib/editor/structurePeekPanel";
import { shouldPreserveEditorFocusOnPeekPointerDown } from "@/lib/editor/focusedQueryEditorView";
import { tableColumnDefaultDisplayValue } from "@/lib/table/tableColumnDefaultPresentation";
import { filterObjectBrowserTableColumns } from "@/lib/table/objectBrowserTableInfo";
import type { ColumnInfo } from "@/types/database";

export type TableStructurePeekInsertKind = "identifier" | "raw";

defineOptions({ name: "TableStructurePeekDialog" });

const props = defineProps<{
  tableName: string;
  schema?: string;
  columns: ColumnInfo[];
  loading: boolean;
  error?: string;
  zIndex?: number;
  /** 0-based index among open panels; used only for initial cascade placement. */
  cascadeIndex?: number;
}>();

const emit = defineEmits<{
  insertValue: [value: string, kind: TableStructurePeekInsertKind];
  close: [];
  activate: [];
}>();

const { t } = useI18n();
const searchQuery = ref("");

const panelLeft = ref(0);
const panelTop = ref(0);
const panelWidth = ref(STRUCTURE_PEEK_MIN_WIDTH);
const panelHeight = ref(STRUCTURE_PEEK_MIN_HEIGHT);
const interacting = ref(false);

type InteractionMode = "move" | "resize";
let interactionMode: InteractionMode | null = null;
let resizeEdge: StructurePeekResizeEdge | null = null;
let dragPointerId: number | null = null;
let startClientX = 0;
let startClientY = 0;
let originLeft = 0;
let originTop = 0;
let originWidth = 0;
let originHeight = 0;

const title = computed(() => {
  const parts = [props.schema, props.tableName].filter((part) => typeof part === "string" && part.length > 0);
  return parts.length > 0 ? parts.join(".") : props.tableName;
});

const filteredColumns = computed(() => filterObjectBrowserTableColumns(props.columns, searchQuery.value));

const panelStyle = computed(() => {
  const style: Record<string, string> = {
    left: `${panelLeft.value}px`,
    top: `${panelTop.value}px`,
    width: `${panelWidth.value}px`,
    height: `${panelHeight.value}px`,
    zIndex: String(props.zIndex ?? 50),
  };
  if (interacting.value) style.transition = "none";
  return style;
});

const resizeEdges: StructurePeekResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function viewportSize() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function applyRect(rect: { left: number; top: number; width: number; height: number }) {
  panelLeft.value = rect.left;
  panelTop.value = rect.top;
  panelWidth.value = rect.width;
  panelHeight.value = rect.height;
}

function initializeGeometry() {
  const { width: vw, height: vh } = viewportSize();
  const size = defaultStructurePeekSize(vw, vh);
  applyRect(centeredStructurePeekRect(size.width, size.height, vw, vh, props.cascadeIndex ?? 0));
}

function clampToViewport() {
  const { width: vw, height: vh } = viewportSize();
  applyRect(clampStructurePeekRect({ left: panelLeft.value, top: panelTop.value, width: panelWidth.value, height: panelHeight.value }, vw, vh));
}

function formatColumnType(column: ColumnInfo): string {
  return formatMetadataColumnTypeLabel({
    dataType: column.data_type,
    characterMaximumLength: column.character_maximum_length,
    numericPrecision: column.numeric_precision,
    numericScale: column.numeric_scale,
  });
}

function insertableValue(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function insertValue(value: string | null | undefined, kind: TableStructurePeekInsertKind) {
  const trimmed = insertableValue(value);
  if (!trimmed) return;
  emit("insertValue", trimmed, kind);
}

function onCellDblClick(value: string | null | undefined, kind: TableStructurePeekInsertKind) {
  insertValue(value, kind);
}

function closePanel() {
  emit("close");
}

function detachInteractionListeners() {
  window.removeEventListener("pointermove", onInteractionMove, true);
  window.removeEventListener("pointerup", onInteractionEnd, true);
  window.removeEventListener("pointercancel", onInteractionEnd, true);
}

function endInteraction() {
  interacting.value = false;
  interactionMode = null;
  resizeEdge = null;
  dragPointerId = null;
  detachInteractionListeners();
}

function onInteractionMove(event: PointerEvent) {
  if (!interactionMode) return;
  if (dragPointerId != null && event.pointerId !== dragPointerId) return;
  event.preventDefault();
  const { width: vw, height: vh } = viewportSize();
  const deltaX = event.clientX - startClientX;
  const deltaY = event.clientY - startClientY;

  if (interactionMode === "move") {
    applyRect(
      clampStructurePeekRect(
        {
          left: originLeft + deltaX,
          top: originTop + deltaY,
          width: originWidth,
          height: originHeight,
        },
        vw,
        vh,
      ),
    );
    return;
  }

  if (interactionMode === "resize" && resizeEdge) {
    applyRect(resizeStructurePeekRect({ left: originLeft, top: originTop, width: originWidth, height: originHeight }, resizeEdge, deltaX, deltaY, vw, vh));
  }
}

function onInteractionEnd(event: PointerEvent) {
  // Always tear down an active interaction. A mismatched pointerId (or a lost
  // pointerup after HMR) must not leave capture-phase preventDefault listeners
  // attached to window — that freezes clicks / context menus app-wide.
  if (!interactionMode && dragPointerId == null) return;
  if (dragPointerId != null && event.pointerId !== dragPointerId) {
    endInteraction();
    clampToViewport();
    return;
  }
  event.preventDefault();
  endInteraction();
  clampToViewport();
}

function beginInteraction(event: PointerEvent, mode: InteractionMode, edge: StructurePeekResizeEdge | null = null) {
  if (event.pointerType === "mouse" && event.button !== 0) return;

  event.preventDefault();
  event.stopPropagation();
  emit("activate");

  // Drop any previous interaction before arming a new one (HMR / missed pointerup).
  endInteraction();

  interacting.value = true;
  interactionMode = mode;
  resizeEdge = edge;
  dragPointerId = event.pointerId;
  startClientX = event.clientX;
  startClientY = event.clientY;
  originLeft = panelLeft.value;
  originTop = panelTop.value;
  originWidth = panelWidth.value;
  originHeight = panelHeight.value;
  window.addEventListener("pointermove", onInteractionMove, true);
  window.addEventListener("pointerup", onInteractionEnd, true);
  window.addEventListener("pointercancel", onInteractionEnd, true);

  try {
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
  } catch {
    // ignore
  }
}

function startDrag(event: PointerEvent) {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-no-drag]")) return;
  beginInteraction(event, "move");
}

function startResize(event: PointerEvent, edge: StructurePeekResizeEdge) {
  beginInteraction(event, "resize", edge);
}

function onPanelActivate(event?: PointerEvent) {
  emit("activate");
  // Keep the focused editor's caret so dblclick can insert across editors.
  if (event && shouldPreserveEditorFocusOnPeekPointerDown(event.target)) {
    event.preventDefault();
  }
}

function onWindowResize() {
  clampToViewport();
}

onMounted(() => {
  initializeGeometry();
  window.addEventListener("resize", onWindowResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
  endInteraction();
});

watch(
  () => props.tableName,
  () => {
    searchQuery.value = "";
  },
);
</script>

<template>
  <Teleport to="body">
    <div
      data-structure-peek-panel
      role="dialog"
      aria-modal="false"
      :aria-label="t('editor.structurePeek.title', { name: title })"
      class="dbx-structure-peek-panel fixed flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl ring-1 ring-border/60"
      :class="{ 'is-dragging': interacting }"
      :style="panelStyle"
      @pointerdown="onPanelActivate"
    >
      <div data-structure-peek-drag-chrome class="flex shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing" @pointerdown="startDrag">
        <button
          type="button"
          data-drag-handle
          class="dbx-structure-peek-drag-handle inline-flex h-7 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          :title="t('editor.structurePeek.drag')"
          :aria-label="t('editor.structurePeek.drag')"
          @pointerdown="startDrag"
        >
          <GripVertical class="pointer-events-none h-4 w-4" />
        </button>
        <div class="min-w-0 flex-1 select-none">
          <div class="truncate text-sm font-medium">{{ t("editor.structurePeek.title", { name: title }) }}</div>
          <div class="truncate text-xs text-muted-foreground">{{ t("editor.structurePeek.hint") }}</div>
        </div>
        <Button type="button" variant="ghost" size="sm" data-no-drag class="h-7 w-7 shrink-0 p-0" :title="t('common.close')" :aria-label="t('common.close')" @pointerdown.stop @click="closePanel">
          <X class="h-4 w-4" />
        </Button>
      </div>

      <div data-no-drag class="shrink-0 border-b border-border px-3 py-2" @pointerdown.stop="onPanelActivate">
        <Input v-model="searchQuery" class="h-8 text-xs" :placeholder="t('structureEditor.searchColumns')" :disabled="props.loading" />
      </div>

      <div data-no-drag class="min-h-0 flex-1 overflow-auto" @pointerdown.stop="onPanelActivate">
        <div v-if="props.loading" class="flex h-40 items-center justify-center">
          <Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
        <div v-else-if="props.error" class="p-4 text-xs text-destructive">{{ props.error }}</div>
        <div v-else-if="filteredColumns.length === 0" class="p-6 text-center text-xs text-muted-foreground">
          {{ searchQuery.trim() ? t("grid.tableInfoNoResults") : t("editor.structurePeek.empty") }}
        </div>
        <table v-else class="w-full text-xs">
          <thead class="sticky top-0 z-10 bg-muted text-muted-foreground">
            <tr class="border-b">
              <th class="w-8 px-3 py-2 text-left font-medium text-nowrap">#</th>
              <th class="px-3 py-2 text-left font-medium text-nowrap">{{ t("grid.columnName") }}</th>
              <th class="px-3 py-2 text-left font-medium text-nowrap">{{ t("grid.columnType") }}</th>
              <th class="px-3 py-2 text-left font-medium text-nowrap">{{ t("grid.tableInfoNullable") }}</th>
              <th class="px-3 py-2 text-left font-medium text-nowrap">{{ t("structureEditor.defaultValue") }}</th>
              <th class="px-3 py-2 text-left font-medium text-nowrap">{{ t("structureEditor.comment") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(column, index) in filteredColumns" :key="column.name" class="border-b hover:bg-muted/40">
              <td class="w-8 px-3 py-2 text-muted-foreground">{{ index + 1 }}</td>
              <td class="cursor-pointer px-3 py-2 font-medium" :title="t('editor.structurePeek.doubleClickInsert')" @dblclick.stop="onCellDblClick(column.name, 'identifier')">
                <span class="inline-flex items-center gap-1.5">
                  <KeyRound v-if="column.is_primary_key" class="h-3 w-3 text-amber-500" />
                  {{ column.name }}
                </span>
              </td>
              <td class="cursor-pointer px-3 py-2 font-mono text-[11px] text-muted-foreground" :title="t('editor.structurePeek.doubleClickInsert')" @dblclick.stop="onCellDblClick(formatColumnType(column), 'raw')">
                {{ formatColumnType(column) }}
              </td>
              <td class="cursor-pointer px-3 py-2" :title="t('editor.structurePeek.doubleClickInsert')" @dblclick.stop="onCellDblClick(column.is_nullable ? 'YES' : 'NO', 'raw')">
                {{ column.is_nullable ? "YES" : "NO" }}
              </td>
              <td
                class="max-w-48 px-3 py-2 font-mono text-[11px]"
                :class="insertableValue(column.column_default) ? 'cursor-pointer' : 'text-muted-foreground/70'"
                :title="insertableValue(column.column_default) ? t('editor.structurePeek.doubleClickInsert') : undefined"
                @dblclick.stop="onCellDblClick(column.column_default, 'raw')"
              >
                <span class="block truncate">{{ tableColumnDefaultDisplayValue(column.column_default) }}</span>
              </td>
              <td class="max-w-56 px-3 py-2 text-muted-foreground" :class="{ 'cursor-pointer': !!insertableValue(column.comment) }" :title="insertableValue(column.comment) ? t('editor.structurePeek.doubleClickInsert') : undefined" @dblclick.stop="onCellDblClick(column.comment, 'raw')">
                <span class="block truncate">{{ column.comment || "—" }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-for="edge in resizeEdges" :key="edge" data-no-drag class="dbx-structure-peek-resize" :class="`dbx-structure-peek-resize--${edge}`" @pointerdown.stop="startResize($event, edge)" />
    </div>
  </Teleport>
</template>

<style scoped>
.dbx-structure-peek-panel.is-dragging {
  user-select: none;
}

.dbx-structure-peek-drag-handle {
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.dbx-structure-peek-panel.is-dragging .dbx-structure-peek-drag-handle {
  cursor: grabbing;
}

.dbx-structure-peek-resize {
  position: absolute;
  z-index: 20;
  touch-action: none;
}

.dbx-structure-peek-resize--n,
.dbx-structure-peek-resize--s {
  left: 6px;
  right: 6px;
  height: 6px;
  cursor: ns-resize;
}

.dbx-structure-peek-resize--e,
.dbx-structure-peek-resize--w {
  top: 6px;
  bottom: 6px;
  width: 6px;
  cursor: ew-resize;
}

.dbx-structure-peek-resize--n {
  top: -3px;
}

.dbx-structure-peek-resize--s {
  bottom: -3px;
}

.dbx-structure-peek-resize--e {
  right: -3px;
}

.dbx-structure-peek-resize--w {
  left: -3px;
}

.dbx-structure-peek-resize--ne,
.dbx-structure-peek-resize--nw,
.dbx-structure-peek-resize--se,
.dbx-structure-peek-resize--sw {
  width: 10px;
  height: 10px;
}

.dbx-structure-peek-resize--ne {
  top: -4px;
  right: -4px;
  cursor: nesw-resize;
}

.dbx-structure-peek-resize--nw {
  top: -4px;
  left: -4px;
  cursor: nwse-resize;
}

.dbx-structure-peek-resize--se {
  bottom: -4px;
  right: -4px;
  cursor: nwse-resize;
}

.dbx-structure-peek-resize--sw {
  bottom: -4px;
  left: -4px;
  cursor: nesw-resize;
}
</style>
