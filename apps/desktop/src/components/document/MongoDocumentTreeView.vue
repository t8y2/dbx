<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { Binary, Braces, Brackets, Calendar, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleSlash, Clock, Columns3, Copy, FileJson, Filter, Fingerprint, Hash, Key, Pencil, Regex, SquarePen, ToggleLeft, Type } from "@lucide/vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatMongoShellLiteral, parseMongoTreeEditValue } from "@/lib/mongo/mongoDocumentValues";
import { buildMongoTreeRows, buildMongoValueFilter, collectMongoTreeContainerIds, isMongoSubdocument, isMongoTreeEditable, mongoPathToDotted, mongoPathWithoutIndexes, mongoTreeEditText, mongoTreeRowId, type MongoFieldPath, type MongoTreeRow } from "@/lib/mongo/mongoDocumentTree";
import { useToast } from "@/composables/useToast";

/**
 * NoSQLBooster-style Tree view: one row per document with Key | Value | Type
 * columns; subdocuments and arrays expand in place. Rows are virtualized so a
 * page of large documents stays responsive.
 */
const props = withDefaults(
  defineProps<{
    documents: Record<string, unknown>[];
    /** Page offset, so root labels read (51), (52)… on page two. */
    indexOffset?: number;
    selectedIndex?: number | null;
    fontStyle?: Record<string, string>;
    /** Whole-document editing is available (opens the Document view editor). */
    editable?: boolean;
    emptyText?: string;
    /** Dot path (array positions removed) → label such as "asc index". */
    indexLabels?: ReadonlyMap<string, string>;
    /** Show "Filter by this value" (collection browser). */
    canFilter?: boolean;
    /** Show "Show as column" (switches to the Table view with the field expanded). */
    canShowColumn?: boolean;
    /** Saves an inline edit; omit to make values read-only. Rejects with a message on failure. */
    saveValue?: (request: { documentIndex: number; path: MongoFieldPath; value: unknown }) => Promise<void>;
  }>(),
  { indexOffset: 0, selectedIndex: null, fontStyle: () => ({}), editable: false, emptyText: "", indexLabels: undefined, canFilter: false, canShowColumn: false, saveValue: undefined },
);

const emit = defineEmits<{
  select: [index: number];
  edit: [index: number];
  filter: [filter: Record<string, unknown>];
  showColumn: [path: string, isSubdocument: boolean];
}>();

const i18n = useI18n();
const { t } = i18n;
const displayLocale = computed(() => String(i18n.locale?.value || "") || undefined);
const settingsStore = useSettingsStore();
const { toast } = useToast();

// Same font as the data grid, so the tree reads like NoSQLBooster's grid-style tree.
const treeFontSize = computed(() => Number(settingsStore.editorSettings?.tableFontSize) || 13);
const treeFontStyle = computed(() => ({ fontFamily: settingsStore.editorSettings?.tableFontFamily || undefined, fontSize: `${treeFontSize.value}px` }));
const ROW_HEIGHT_MIN = 24;
const OVERSCAN = 12;

const expanded = ref<Set<string>>(new Set());
const activeRowId = ref<string | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(400);
const scrollRef = ref<HTMLDivElement>();

const keyWidth = ref(320);
const typeWidth = ref(110);

const ROW_HEIGHT = computed(() => Math.max(ROW_HEIGHT_MIN, Math.round(treeFontSize.value * 1.9)));

const countLabels = {
  fields: (count: number) => t("mongo.treeFieldsSummary", { count }, count),
  elements: (count: number) => t("mongo.treeElementsSummary", { count }, count),
};

// "… minutes ago" stays current while the tab is open.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 60_000);
});
onBeforeUnmount(() => clearInterval(clock));

const rows = computed<MongoTreeRow[]>(() =>
  buildMongoTreeRows(props.documents, {
    expanded: expanded.value,
    indexOffset: props.indexOffset,
    display: { locale: displayLocale.value, now: now.value, countLabels },
  }),
);

const totalHeight = computed(() => rows.value.length * ROW_HEIGHT.value);
const firstVisible = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT.value) - OVERSCAN));
const lastVisible = computed(() => Math.min(rows.value.length, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT.value) + OVERSCAN));
const visibleRows = computed(() => rows.value.slice(firstVisible.value, lastVisible.value));

// A new page or a refreshed collection has different documents; stale ids would
// expand unrelated rows. When the same documents come back (an inline edit, a
// refresh of the same page) every expansion is kept; otherwise only roots.
function documentIdentity(documents: readonly Record<string, unknown>[]): string {
  return JSON.stringify(documents.map((document) => document._id ?? null));
}

watch(
  () => props.documents,
  (next, previous) => {
    if (next === previous) return;
    if (previous && documentIdentity(next) === documentIdentity(previous)) return;
    const keep = new Set<string>();
    for (const id of expanded.value) if (!id.includes("/") && Number(id) < next.length) keep.add(id);
    expanded.value = keep;
    if (activeRowId.value && !rows.value.some((row) => row.id === activeRowId.value)) activeRowId.value = null;
  },
);

function onScroll(event: Event) {
  const target = event.target as HTMLDivElement;
  scrollTop.value = target.scrollTop;
  viewportHeight.value = target.clientHeight;
}

function toggle(row: MongoTreeRow) {
  if (!row.expandable) return;
  const next = new Set(expanded.value);
  if (next.has(row.id)) {
    for (const id of next) if (id === row.id || id.startsWith(`${row.id}/`)) next.delete(id);
  } else {
    next.add(row.id);
  }
  expanded.value = next;
}

function expandAll() {
  expanded.value = new Set(collectMongoTreeContainerIds(props.documents));
}

function collapseAll() {
  expanded.value = new Set();
}

function selectRow(row: MongoTreeRow) {
  activeRowId.value = row.id;
  emit("select", row.documentIndex);
}

function rowFullValueText(row: MongoTreeRow): string {
  if (typeof row.value === "string") return row.value;
  return formatMongoShellLiteral(row.value, { pretty: row.expandable });
}

async function copyValue(row: MongoTreeRow) {
  await copyToClipboard(rowFullValueText(row));
  toast(t("mongo.treeCopiedValue"), 1500);
}

async function copyPath(row: MongoTreeRow) {
  if (!row.path.length) return;
  await copyToClipboard(mongoPathToDotted(row.path));
  toast(t("mongo.treeCopiedPath"), 1500);
}

function ensureRowVisible(index: number) {
  const element = scrollRef.value;
  if (!element) return;
  const height = ROW_HEIGHT.value;
  const top = index * height;
  if (top < element.scrollTop) element.scrollTop = top;
  else if (top + height > element.scrollTop + element.clientHeight) element.scrollTop = top + height - element.clientHeight;
}

function onKeydown(event: KeyboardEvent) {
  if (editing.value) return;
  const list = rows.value;
  if (!list.length) return;
  let index = list.findIndex((row) => row.id === activeRowId.value);
  const row = index >= 0 ? list[index] : undefined;
  switch (event.key) {
    case "ArrowDown":
      index = Math.min(list.length - 1, index + 1);
      break;
    case "ArrowUp":
      index = Math.max(0, index < 0 ? 0 : index - 1);
      break;
    case "ArrowRight":
      if (row?.expandable && !row.expanded) toggle(row);
      else if (row?.expanded) index = Math.min(list.length - 1, index + 1);
      break;
    case "ArrowLeft":
      if (row?.expanded) toggle(row);
      else if (row && row.path.length) {
        const parentId = mongoTreeRowId(row.documentIndex, row.path.slice(0, -1));
        index = list.findIndex((candidate) => candidate.id === parentId);
      }
      break;
    case "Enter":
    case " ":
      if (row) toggle(row);
      break;
    case "F2":
      if (row) startEdit(row);
      break;
    default:
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && row) {
        event.preventDefault();
        void copyValue(row);
      }
      return;
  }
  event.preventDefault();
  const next = rows.value[Math.max(0, index)];
  if (next) {
    selectRow(next);
    void nextTick(() => ensureRowVisible(rows.value.findIndex((candidate) => candidate.id === next.id)));
  }
}

function startResize(event: PointerEvent, column: "key" | "type") {
  const startX = event.clientX;
  const start = column === "key" ? keyWidth.value : typeWidth.value;
  const move = (moveEvent: PointerEvent) => {
    const delta = moveEvent.clientX - startX;
    if (column === "key") keyWidth.value = Math.max(120, Math.min(900, start + delta));
    else typeWidth.value = Math.max(60, Math.min(300, start - delta));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

const NUMBER_CLASS = "text-orange-600 dark:text-orange-400";
const TYPE_CLASSES: Record<string, string> = {
  String: "text-lime-700 dark:text-lime-300",
  Int32: NUMBER_CLASS,
  Int64: NUMBER_CLASS,
  Double: NUMBER_CLASS,
  Decimal128: NUMBER_CLASS,
  Bool: "text-violet-600 dark:text-violet-300",
  Date: "text-amber-600 dark:text-amber-300",
  Timestamp: "text-amber-600 dark:text-amber-300",
  ObjectId: "text-rose-600 dark:text-rose-400",
  Null: "text-muted-foreground italic",
};

const TYPE_ICONS: Record<string, Component> = {
  String: Type,
  Int32: Hash,
  Int64: Hash,
  Double: Hash,
  Decimal128: Hash,
  Bool: ToggleLeft,
  Date: Calendar,
  Timestamp: Clock,
  ObjectId: Fingerprint,
  Null: CircleSlash,
  Object: Braces,
  Array: Brackets,
  Document: FileJson,
  Binary: Binary,
  UUID: Fingerprint,
  Regex: Regex,
};

function valueClass(row: MongoTreeRow): string {
  return TYPE_CLASSES[row.type] ?? "";
}

function rowIcon(row: MongoTreeRow): Component | undefined {
  if (row.path.length === 1 && row.path[0] === "_id") return Key;
  return TYPE_ICONS[row.type];
}

const gridTemplate = computed(() => `${keyWidth.value}px minmax(0,1fr) ${typeWidth.value}px`);

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

const menu = ref<{ x: number; y: number; row: MongoTreeRow } | null>(null);
const menuRef = ref<HTMLDivElement>();

function openMenu(event: MouseEvent, row: MongoTreeRow) {
  selectRow(row);
  menu.value = { x: event.clientX, y: event.clientY, row };
  // Keep the menu on screen once its real size is known (flip up/left near edges).
  void nextTick(() => {
    const element = menuRef.value;
    const current = menu.value;
    if (!element || !current) return;
    const { width, height } = element.getBoundingClientRect();
    const x = current.x + width > window.innerWidth - 8 ? Math.max(8, current.x - width) : current.x;
    const y = current.y + height > window.innerHeight - 8 ? Math.max(8, current.y - height) : current.y;
    if (x !== current.x || y !== current.y) menu.value = { ...current, x, y };
  });
}

function closeMenu() {
  menu.value = null;
}

function onWindowPointerDown(event: PointerEvent) {
  if (menu.value && !menuRef.value?.contains(event.target as Node)) closeMenu();
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") closeMenu();
}

onMounted(() => {
  window.addEventListener("pointerdown", onWindowPointerDown, true);
  window.addEventListener("keydown", onWindowKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", onWindowPointerDown, true);
  window.removeEventListener("keydown", onWindowKeydown);
});

function documentOf(row: MongoTreeRow): Record<string, unknown> {
  return props.documents[row.documentIndex] ?? {};
}

async function copyText(text: string, message: string) {
  await copyToClipboard(text);
  toast(message, 1500);
}

function rowFilter(row: MongoTreeRow): Record<string, unknown> {
  return buildMongoValueFilter(documentOf(row), row.path);
}

function canShowAsColumn(row: MongoTreeRow): boolean {
  if (!props.canShowColumn || !row.path.length || row.path[0] === "_id" || row.path.some((step) => typeof step === "number")) return false;
  return row.path.length > 1 || isMongoSubdocument(row.value);
}

function canEditInline(row: MongoTreeRow): boolean {
  return !!props.saveValue && isMongoTreeEditable(row);
}

async function runMenu(action: string) {
  const row = menu.value?.row;
  closeMenu();
  if (!row) return;
  switch (action) {
    case "copy-value":
      return copyValue(row);
    case "copy-path":
      return copyPath(row);
    case "copy-filter":
      return copyText(JSON.stringify(rowFilter(row)), t("mongo.treeCopiedFilter"));
    case "copy-document":
      return copyText(formatMongoShellLiteral(documentOf(row), { pretty: true }), t("mongo.treeCopiedDocument"));
    case "filter":
      return emit("filter", rowFilter(row));
    case "show-column":
      return emit("showColumn", mongoPathWithoutIndexes(row.path), isMongoSubdocument(row.value));
    case "edit-value":
      return startEdit(row);
    case "edit-document":
      return emit("edit", row.documentIndex);
    case "expand":
      return expandBelow(row);
    case "collapse":
      if (row.expanded) toggle(row);
      return;
  }
}

function expandBelow(row: MongoTreeRow) {
  const prefix = row.id;
  const next = new Set(expanded.value);
  next.add(prefix);
  for (const id of collectMongoTreeContainerIds([documentOf(row)], 6)) {
    const scoped = id.replace(/^0/, String(row.documentIndex));
    if (scoped === prefix || scoped.startsWith(`${prefix}/`)) next.add(scoped);
  }
  expanded.value = next;
}

// ---------------------------------------------------------------------------
// Inline editing
// ---------------------------------------------------------------------------

const editing = ref<{ rowId: string; text: string; saving: boolean } | null>(null);
const editInputRef = ref<HTMLInputElement[]>();

function startEdit(row: MongoTreeRow) {
  if (!canEditInline(row)) return;
  activeRowId.value = row.id;
  editing.value = { rowId: row.id, text: mongoTreeEditText(row.value), saving: false };
  void nextTick(() => {
    const input = editInputRef.value?.[0];
    input?.focus();
    input?.select();
  });
}

function cancelEdit() {
  editing.value = null;
  void nextTick(() => scrollRef.value?.focus());
}

async function commitEdit(row: MongoTreeRow) {
  const state = editing.value;
  if (!state || state.saving || state.rowId !== row.id || !props.saveValue) return;
  if (state.text === mongoTreeEditText(row.value)) return cancelEdit();
  const parsed = parseMongoTreeEditValue(state.text, row.value);
  if (!parsed.ok) {
    toast(t("mongo.treeEditInvalid", { type: row.type }), 3000);
    return;
  }
  state.saving = true;
  try {
    await props.saveValue({ documentIndex: row.documentIndex, path: row.path, value: parsed.value });
    editing.value = null;
    toast(t("mongo.treeEditSaved", { path: mongoPathToDotted(row.path) }), 1500);
    void nextTick(() => scrollRef.value?.focus());
  } catch (error) {
    state.saving = false;
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}

function onValueDoubleClick(row: MongoTreeRow) {
  if (row.expandable) toggle(row);
  else if (canEditInline(row)) startEdit(row);
  else if (props.editable) emit("edit", row.documentIndex);
}

function indexLabel(row: MongoTreeRow): string | undefined {
  if (!row.path.length || !props.indexLabels) return undefined;
  return props.indexLabels.get(mongoPathWithoutIndexes(row.path));
}

defineExpose({ expandAll, collapseAll });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden text-xs" :style="treeFontStyle" data-mongo-tree-view>
    <div class="grid shrink-0 select-none border-b bg-muted/40 font-medium text-muted-foreground" :style="{ gridTemplateColumns: gridTemplate }">
      <div class="relative flex h-7 items-center gap-1 border-r px-2">
        <span class="flex-1 truncate">{{ t("mongo.treeKey") }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('mongo.treeExpandAll')" @click="expandAll"><ChevronsUpDown class="h-3 w-3" /></Button>
        <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('mongo.treeCollapseAll')" @click="collapseAll"><ChevronsDownUp class="h-3 w-3" /></Button>
        <span class="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize" @pointerdown.prevent="startResize($event, 'key')" />
      </div>
      <div class="relative flex h-7 items-center border-r px-2">
        <span class="truncate">{{ t("mongo.treeValue") }}</span>
        <span class="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize" @pointerdown.prevent="startResize($event, 'type')" />
      </div>
      <div class="flex h-7 items-center px-2">
        <span class="truncate">{{ t("mongo.treeType") }}</span>
      </div>
    </div>

    <div v-if="!documents.length" class="flex flex-1 items-center justify-center text-muted-foreground">{{ emptyText }}</div>
    <div v-else ref="scrollRef" class="relative flex-1 min-h-0 overflow-auto outline-none" tabindex="0" :style="treeFontStyle" @scroll="onScroll" @keydown="onKeydown">
      <div :style="{ height: `${totalHeight}px` }" class="relative">
        <div
          v-for="(row, offset) in visibleRows"
          :key="row.id"
          class="group absolute left-0 right-0 grid cursor-default items-center border-b border-border/40"
          :class="[row.id === activeRowId ? 'bg-primary/20' : row.documentIndex === selectedIndex && row.depth === 0 ? 'bg-accent/60' : (firstVisible + offset) % 2 ? 'bg-muted/25 hover:bg-accent/40' : 'hover:bg-accent/40', row.depth === 0 ? 'font-medium' : '']"
          :style="{ top: `${(firstVisible + offset) * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px`, gridTemplateColumns: gridTemplate }"
          :data-tree-row="row.id"
          @click="selectRow(row)"
          @dblclick="onValueDoubleClick(row)"
          @contextmenu.prevent="openMenu($event, row)"
        >
          <div class="flex min-w-0 items-center border-r border-border/40 pr-1" :style="{ paddingLeft: `${4 + row.depth * 16}px` }">
            <button v-if="row.expandable" type="button" class="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-accent" :aria-expanded="row.expanded" @click.stop="toggle(row)">
              <ChevronRight class="h-3 w-3 transition-transform" :class="{ 'rotate-90': row.expanded }" />
            </button>
            <span v-else class="w-4 shrink-0" />
            <component :is="rowIcon(row)" v-if="rowIcon(row)" class="ml-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="ml-1 truncate" :class="row.isArrayElement ? 'text-muted-foreground' : ''" :title="row.path.length ? mongoPathToDotted(row.path) : row.key">{{ row.key }}</span>
            <span v-if="indexLabel(row)" class="ml-1 shrink-0 text-muted-foreground" data-tree-index-label>({{ indexLabel(row) }})</span>
            <span class="ml-auto hidden shrink-0 items-center gap-0.5 pl-1 group-hover:flex">
              <button v-if="row.path.length" type="button" class="rounded px-1 text-[10px] text-muted-foreground hover:bg-background hover:text-foreground" :title="t('mongo.treeCopyPath')" @click.stop="copyPath(row)">.path</button>
              <button type="button" class="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground" :title="t('mongo.treeCopyValue')" @click.stop="copyValue(row)"><Copy class="h-3 w-3" /></button>
              <button v-if="editable && row.depth === 0" type="button" class="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground" :title="t('mongo.edit')" @click.stop="emit('edit', row.documentIndex)">
                <SquarePen class="h-3 w-3" />
              </button>
            </span>
          </div>
          <div v-if="editing?.rowId === row.id" class="flex h-full min-w-0 items-center border-r border-border/40 px-1" @dblclick.stop @click.stop>
            <input
              ref="editInputRef"
              v-model="editing.text"
              class="h-[calc(100%-4px)] w-full min-w-0 rounded border border-primary bg-background px-1 outline-none"
              :class="valueClass(row)"
              :disabled="editing.saving"
              spellcheck="false"
              data-tree-edit-input
              @keydown.enter.prevent="commitEdit(row)"
              @keydown.esc.prevent="cancelEdit"
              @keydown.stop
              @blur="!editing?.saving && cancelEdit()"
            />
          </div>
          <div v-else class="min-w-0 truncate border-r border-border/40 px-2" :class="{ 'cursor-text': canEditInline(row) }" :title="row.tooltip ?? row.valueText">
            <span :class="valueClass(row)">{{ row.valueText }}</span>
            <span v-if="row.valueHint" class="ml-2 text-foreground/80">{{ row.valueHint }}</span>
          </div>
          <div class="min-w-0 truncate px-2" :class="valueClass(row) || 'text-muted-foreground'">{{ row.type }}</div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="menu" ref="menuRef" class="fixed z-50 min-w-52 overflow-hidden rounded-md border bg-popover py-1 text-xs text-popover-foreground shadow-xl" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" role="menu" data-tree-menu @contextmenu.prevent>
        <button v-if="canEditInline(menu.row)" type="button" class="tree-menu-item" role="menuitem" data-action="edit-value" @click="runMenu('edit-value')"><Pencil class="h-3.5 w-3.5" />{{ t("mongo.treeEditValue") }}<span class="ml-auto pl-4 text-muted-foreground">F2</span></button>
        <button v-if="editable" type="button" class="tree-menu-item" role="menuitem" data-action="edit-document" @click="runMenu('edit-document')"><SquarePen class="h-3.5 w-3.5" />{{ t("mongo.treeEditDocument") }}</button>
        <div v-if="canEditInline(menu.row) || editable" class="my-1 h-px bg-border" />
        <button v-if="canFilter" type="button" class="tree-menu-item" role="menuitem" data-action="filter" @click="runMenu('filter')"><Filter class="h-3.5 w-3.5" />{{ t("mongo.treeFilterByValue") }}</button>
        <button v-if="canShowAsColumn(menu.row)" type="button" class="tree-menu-item" role="menuitem" data-action="show-column" @click="runMenu('show-column')"><Columns3 class="h-3.5 w-3.5" />{{ t("mongo.treeShowAsColumn") }}</button>
        <div v-if="canFilter || canShowAsColumn(menu.row)" class="my-1 h-px bg-border" />
        <button type="button" class="tree-menu-item" role="menuitem" data-action="copy-value" @click="runMenu('copy-value')"><Copy class="h-3.5 w-3.5" />{{ t("mongo.treeCopyValue") }}<span class="ml-auto pl-4 text-muted-foreground">⌘C</span></button>
        <button v-if="menu.row.path.length" type="button" class="tree-menu-item" role="menuitem" data-action="copy-path" @click="runMenu('copy-path')"><Copy class="h-3.5 w-3.5" />{{ t("mongo.treeCopyPath") }}</button>
        <button type="button" class="tree-menu-item" role="menuitem" data-action="copy-filter" @click="runMenu('copy-filter')"><Copy class="h-3.5 w-3.5" />{{ t("mongo.treeCopyFilter") }}</button>
        <button type="button" class="tree-menu-item" role="menuitem" data-action="copy-document" @click="runMenu('copy-document')"><FileJson class="h-3.5 w-3.5" />{{ t("mongo.treeCopyDocument") }}</button>
        <template v-if="menu.row.expandable">
          <div class="my-1 h-px bg-border" />
          <button type="button" class="tree-menu-item" role="menuitem" data-action="expand" @click="runMenu('expand')"><ChevronsUpDown class="h-3.5 w-3.5" />{{ t("mongo.treeExpandBelow") }}</button>
          <button v-if="menu.row.expanded" type="button" class="tree-menu-item" role="menuitem" data-action="collapse" @click="runMenu('collapse')"><ChevronsDownUp class="h-3.5 w-3.5" />{{ t("mongo.treeCollapse") }}</button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tree-menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.75rem;
  text-align: left;
  white-space: nowrap;
}
.tree-menu-item:hover,
.tree-menu-item:focus-visible {
  background: var(--accent);
  color: var(--accent-foreground);
  outline: none;
}
</style>
