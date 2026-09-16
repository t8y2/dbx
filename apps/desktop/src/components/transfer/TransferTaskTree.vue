<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowRightLeft, ChevronRight, Copy, ExternalLink, FolderClosed, FolderOpen, FolderPlus, Pencil, Plus, Search, Trash2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CustomContextMenu, { type ContextMenuItem as CtxMenuItem } from "@/components/ui/CustomContextMenu.vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { useToast } from "@/composables/useToast";
import { useTransferTaskStore, TransferTaskNameConflictError } from "@/stores/transferTaskStore";
import { focusSidebarRenameInput } from "@/lib/sidebar/sidebarRenameFocus";
import type { TransferTask, TransferTaskFolder } from "@/types/database";

const { t } = useI18n();
const { toast } = useToast();
const taskStore = useTransferTaskStore();

const props = defineProps<{
  selectedTaskId: string | null;
}>();

const emit = defineEmits<{
  /** Request to load a task's config into the form (the dialog may veto when dirty). */
  select: [task: TransferTask];
  /** Request to clear the form and start a new unsaved configuration. */
  newBlank: [];
  "update:selectedTaskId": [id: string | null];
}>();

const UNFILED_DROP_TARGET_ID = "__transfer-task-unfiled__";
const DRAG_THRESHOLD = 5;

type DragItemType = "folder" | "task" | "unfiled";
type DropPosition = "before" | "after" | "inside";

const searchText = ref("");
const searchQuery = computed(() => searchText.value.trim().toLowerCase());

const collapsedFolders = ref<Set<string>>(new Set());

function isFolderExpanded(folderId: string) {
  return !collapsedFolders.value.has(folderId);
}

function toggleFolder(folderId: string) {
  if (suppressNextRowClick.value) return;
  const next = new Set(collapsedFolders.value);
  if (next.has(folderId)) next.delete(folderId);
  else next.add(folderId);
  collapsedFolders.value = next;
}

function taskMatchesQuery(task: TransferTask) {
  const q = searchQuery.value;
  if (!q) return true;
  return [task.name, task.config.sourceDatabase, task.config.targetDatabase].filter(Boolean).some((value) => String(value).toLowerCase().includes(q));
}

function folderMatchesQuery(folder: TransferTaskFolder) {
  const q = searchQuery.value;
  if (!q) return true;
  if (folder.name.toLowerCase().includes(q)) return true;
  return taskStore.listTasks(folder.id).some((task) => taskMatchesQuery(task));
}

function childFolders(parentFolderId?: string) {
  return taskStore.allFolders.filter((folder) => (folder.parentFolderId || "") === (parentFolderId || ""));
}

function descendantFolders(parentFolderId: string): TransferTaskFolder[] {
  const direct = childFolders(parentFolderId);
  return direct.flatMap((folder) => [folder, ...descendantFolders(folder.id)]);
}

function folderBranchMatchesQuery(folder: TransferTaskFolder) {
  if (folderMatchesQuery(folder)) return true;
  return descendantFolders(folder.id).some((child) => folderMatchesQuery(child));
}

function tasksInFolder(folderId: string) {
  const folder = taskStore.allFolders.find((item) => item.id === folderId);
  const includeAllTasksForMatchedFolder = !!folder && !!searchQuery.value && folder.name.toLowerCase().includes(searchQuery.value);
  return taskStore.listTasks(folderId).filter((task) => includeAllTasksForMatchedFolder || taskMatchesQuery(task));
}

function folderTaskCount(folderId: string) {
  let count = taskStore.listTasks(folderId).length;
  for (const child of descendantFolders(folderId)) {
    count += taskStore.listTasks(child.id).length;
  }
  return count;
}

type TaskTreeRow = { type: "folder"; folder: TransferTaskFolder; depth: number } | { type: "task"; task: TransferTask; depth: number };

const visibleFolderRows = computed<TaskTreeRow[]>(() => {
  const rows: TaskTreeRow[] = [];
  const appendFolder = (folder: TransferTaskFolder, depth: number) => {
    if (!folderBranchMatchesQuery(folder)) return;
    rows.push({ type: "folder", folder, depth });
    if (!isFolderExpanded(folder.id)) return;
    for (const child of childFolders(folder.id)) {
      appendFolder(child, depth + 1);
    }
    for (const task of tasksInFolder(folder.id)) {
      rows.push({ type: "task", task, depth: depth + 1 });
    }
  };
  for (const folder of childFolders()) {
    appendFolder(folder, 0);
  }
  return rows;
});

const visibleRootTasks = computed(() => taskStore.listTasks(undefined).filter((task) => taskMatchesQuery(task)));

const hasAnyVisibleItem = computed(() => visibleFolderRows.value.length > 0 || visibleRootTasks.value.length > 0);

function folderPath(folder: TransferTaskFolder) {
  const folderById = new Map(taskStore.allFolders.map((item) => [item.id, item]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let current: TransferTaskFolder | undefined = folder;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = current.parentFolderId ? folderById.get(current.parentFolderId) : undefined;
  }
  return parts.join(" / ");
}

// ---- inline rename (create-then-rename, mirroring SqlLibraryPanel) ----

const renamingTarget = ref<{ type: "folder" | "task"; id: string } | null>(null);
const renameValue = ref("");
const renameInputRef = ref<HTMLInputElement | null>(null);
function setRenameInputRef(el: unknown) {
  renameInputRef.value = (el as HTMLInputElement) ?? null;
}

function isRenamingFolder(folderId: string) {
  return renamingTarget.value?.type === "folder" && renamingTarget.value.id === folderId;
}

function isRenamingTask(taskId: string) {
  return renamingTarget.value?.type === "task" && renamingTarget.value.id === taskId;
}

function startRenameFolder(folder: TransferTaskFolder) {
  resetDragState();
  markSuppressedClick();
  renameInputRef.value = null;
  renamingTarget.value = { type: "folder", id: folder.id };
  renameValue.value = folder.name;
  nextTick(() => {
    focusSidebarRenameInput(() => renameInputRef.value ?? undefined);
  });
}

function startRenameTask(task: TransferTask) {
  resetDragState();
  markSuppressedClick();
  renameInputRef.value = null;
  renamingTarget.value = { type: "task", id: task.id };
  renameValue.value = task.name;
  nextTick(() => {
    focusSidebarRenameInput(() => renameInputRef.value ?? undefined);
  });
}

defineExpose({ startRenameTask });

function renameErrorMessage(error: unknown) {
  return error instanceof TransferTaskNameConflictError ? t("transfer.tasks.nameConflict", { name: error.entryName }) : (error as Error)?.message || String(error);
}

async function confirmRename() {
  if (!renamingTarget.value) return;
  const { type, id } = renamingTarget.value;
  const name = renameValue.value.trim();
  renamingTarget.value = null;
  renameValue.value = "";
  if (!name) return;
  try {
    if (type === "folder") await taskStore.renameFolder(id, name);
    else await taskStore.renameTask(id, name);
  } catch (error) {
    toast(t("transfer.tasks.saveFailed", { message: renameErrorMessage(error) }), 5000);
  }
}

function cancelRename() {
  renamingTarget.value = null;
  renameValue.value = "";
}

/** Default name for a new folder under the given parent: "新建文件夹", "新建文件夹1", ... avoiding sibling conflicts. */
function nextFolderDefaultName(parentFolderId?: string) {
  const base = t("transfer.tasks.newFolderDefault");
  const taken = new Set(taskStore.allFolders.filter((folder) => (folder.parentFolderId || "") === (parentFolderId || "")).map((folder) => folder.name.trim().toLocaleLowerCase()));
  if (!taken.has(base.toLocaleLowerCase())) return base;
  let index = 1;
  while (taken.has(`${base}${index}`.toLocaleLowerCase())) index++;
  return `${base}${index}`;
}

async function openNewFolderInput(parentFolderId?: string) {
  if (parentFolderId) {
    collapsedFolders.value = new Set([...collapsedFolders.value].filter((id) => id !== parentFolderId));
  }
  try {
    const folder = await taskStore.createFolder(nextFolderDefaultName(parentFolderId), parentFolderId);
    searchText.value = "";
    startRenameFolder(folder);
  } catch (error) {
    toast(t("transfer.tasks.saveFailed", { message: renameErrorMessage(error) }), 5000);
  }
}

function requestNewBlank() {
  emit("newBlank");
}

// ---- delete ----

const deleteTarget = ref<{ type: "folder" | "task"; id: string; name: string } | null>(null);
const showDeleteConfirm = ref(false);

function confirmDeleteFolder(folder: TransferTaskFolder) {
  deleteTarget.value = { type: "folder", id: folder.id, name: folder.name };
  showDeleteConfirm.value = true;
}

function confirmDeleteTask(task: TransferTask) {
  deleteTarget.value = { type: "task", id: task.id, name: task.name };
  showDeleteConfirm.value = true;
}

async function executeDelete() {
  if (!deleteTarget.value) return;
  const { type, id } = deleteTarget.value;
  try {
    if (type === "folder") {
      await taskStore.deleteFolder(id);
      // Folder deletion cascades to contained tasks; clear the selection when
      // the currently loaded task was inside the deleted branch.
      if (props.selectedTaskId && !taskStore.getTask(props.selectedTaskId)) {
        emit("update:selectedTaskId", null);
      }
    } else {
      await taskStore.deleteTask(id);
      if (props.selectedTaskId === id) emit("update:selectedTaskId", null);
    }
  } catch (error) {
    toast(t("transfer.tasks.deleteFailed", { message: (error as Error)?.message || String(error) }), 5000);
  }
  showDeleteConfirm.value = false;
  deleteTarget.value = null;
}

async function duplicateTask(task: TransferTask) {
  try {
    const copy = await taskStore.duplicateTask(task.id);
    if (copy) startRenameTask(copy);
  } catch (error) {
    toast(t("transfer.tasks.saveFailed", { message: (error as Error)?.message || String(error) }), 5000);
  }
}

// ---- context menu ----

const contextTarget = ref<TransferTaskFolder | TransferTask | "panel" | null>(null);

function isFolderTarget(target: unknown): target is TransferTaskFolder {
  return !!target && target !== "panel" && !("config" in (target as object));
}

function clearContextTarget() {
  contextTarget.value = null;
}

function taskMoveMenuItems(task: TransferTask): CtxMenuItem[] {
  const folderItems = taskStore.allFolders.map((folder) => ({
    label: folderPath(folder),
    action: () => void moveTask(task.id, folder.id),
    disabled: task.folderId === folder.id,
    icon: FolderClosed,
  }));
  return [{ label: t("transfer.tasks.ungrouped"), action: () => void moveTask(task.id, undefined), disabled: !task.folderId, icon: FolderOpen }, ...(folderItems.length > 0 ? [{ label: "", separator: true } as CtxMenuItem, ...folderItems] : [])];
}

async function moveTask(taskId: string, folderId?: string) {
  try {
    await taskStore.moveTaskToFolder(taskId, folderId);
  } catch (error) {
    toast(t("transfer.tasks.moveFailed", { message: (error as Error)?.message || String(error) }), 5000);
  }
}

const contextMenuItems = computed<CtxMenuItem[]>(() => {
  const target = contextTarget.value;
  if (!target) return [];

  if (target === "panel") {
    return [
      { label: t("transfer.tasks.newTask"), action: requestNewBlank, icon: Plus },
      { label: t("transfer.tasks.newFolder"), action: () => openNewFolderInput(), icon: FolderPlus },
    ];
  }

  if (isFolderTarget(target)) {
    return [
      { label: t("transfer.tasks.newSubfolder"), action: () => openNewFolderInput(target.id), icon: FolderPlus },
      { label: t("transfer.tasks.rename"), action: () => startRenameFolder(target), icon: Pencil },
      { label: "", separator: true },
      { label: t("transfer.tasks.delete"), action: () => confirmDeleteFolder(target), icon: Trash2, variant: "destructive" },
    ];
  }

  return [
    { label: t("transfer.tasks.open"), action: () => emit("select", target), icon: ExternalLink },
    { label: t("transfer.tasks.duplicate"), action: () => duplicateTask(target), icon: Copy },
    { label: t("transfer.tasks.moveToFolder"), icon: FolderClosed, children: taskMoveMenuItems(target) },
    { label: "", separator: true },
    { label: t("transfer.tasks.rename"), action: () => startRenameTask(target), icon: Pencil },
    { label: "", separator: true },
    { label: t("transfer.tasks.delete"), action: () => confirmDeleteTask(target), icon: Trash2, variant: "destructive" },
  ];
});

// ---- drag & drop (mouse-based, mirroring SqlLibraryPanel) ----

const dragState = reactive<{
  active: boolean;
  draggedId: string | null;
  draggedType: DragItemType | null;
  targetId: string | null;
  targetType: DragItemType | null;
  dropPosition: DropPosition | null;
}>({
  active: false,
  draggedId: null,
  draggedType: null,
  targetId: null,
  targetType: null,
  dropPosition: null,
});

let pendingDrag: {
  id: string;
  type: DragItemType;
  startX: number;
  startY: number;
  sourceEl: HTMLElement | null;
} | null = null;
let dragGhostEl: HTMLElement | null = null;
let clearSuppressTimer: number | undefined;
const suppressNextRowClick = ref(false);

function markSuppressedClick() {
  suppressNextRowClick.value = true;
  window.clearTimeout(clearSuppressTimer);
  clearSuppressTimer = window.setTimeout(() => {
    suppressNextRowClick.value = false;
  }, 0);
}

function resetDragState() {
  dragState.active = false;
  dragState.draggedId = null;
  dragState.draggedType = null;
  dragState.targetId = null;
  dragState.targetType = null;
  dragState.dropPosition = null;
  pendingDrag = null;
  if (dragGhostEl) {
    dragGhostEl.remove();
    dragGhostEl = null;
  }
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function createDragGhost(sourceEl: HTMLElement, x: number, y: number) {
  const ghost = document.createElement("div");
  const textNode = sourceEl.querySelector(".dbx-transfer-task-drag-label");
  ghost.textContent = textNode?.textContent || "";
  ghost.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 9999;
    opacity: 0.9;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    border-radius: var(--dbx-radius-fixed-4);
    background: var(--background, #fff);
    border: 1px solid var(--border, #e5e7eb);
    max-width: 220px;
    height: 24px;
    padding: 0 8px;
    font-size: 13px;
    line-height: 24px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    left: ${x + 8}px;
    top: ${y - 12}px;
  `;
  document.body.appendChild(ghost);
  return ghost;
}

function moveDragGhost(x: number, y: number) {
  if (!dragGhostEl) return;
  dragGhostEl.style.left = `${x + 8}px`;
  dragGhostEl.style.top = `${y - 12}px`;
}

function onDocumentMouseMove(event: MouseEvent) {
  if (!pendingDrag && !dragState.active) return;

  if (pendingDrag && !dragState.active) {
    const dx = event.clientX - pendingDrag.startX;
    const dy = event.clientY - pendingDrag.startY;
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

    dragState.active = true;
    dragState.draggedId = pendingDrag.id;
    dragState.draggedType = pendingDrag.type;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    if (pendingDrag.sourceEl) {
      dragGhostEl = createDragGhost(pendingDrag.sourceEl, event.clientX, event.clientY);
    }
    pendingDrag = null;
  }

  if (dragState.active) {
    moveDragGhost(event.clientX, event.clientY);
  }
}

async function performDrop() {
  const draggedId = dragState.draggedId;
  const draggedType = dragState.draggedType;
  const targetId = dragState.targetId;
  const targetType = dragState.targetType;
  const dropPosition = dragState.dropPosition;
  if (!draggedId || !draggedType || !targetId || !targetType || !dropPosition) return;

  if (draggedType === "folder" && targetType === "folder" && dropPosition !== "inside") {
    await taskStore.reorderFolders(draggedId, targetId, dropPosition);
    return;
  }

  if (draggedType === "folder" && targetType === "folder" && dropPosition === "inside") {
    await taskStore.moveFolderToFolder(draggedId, targetId);
    return;
  }

  if (draggedType !== "task") return;

  if (targetType === "folder") {
    await taskStore.moveTaskToFolder(draggedId, targetId);
    return;
  }

  if (targetType === "unfiled") {
    await taskStore.moveTaskToFolder(draggedId, undefined);
    return;
  }

  if (targetType === "task" && dropPosition !== "inside") {
    await taskStore.reorderTasks(draggedId, targetId, dropPosition);
  }
}

function onDocumentMouseUp() {
  const hadActiveDrag = dragState.active;
  const dropPromise = hadActiveDrag ? performDrop() : Promise.resolve();
  if (hadActiveDrag) markSuppressedClick();
  resetDragState();
  void dropPromise.catch((error) => toast(t("transfer.tasks.moveFailed", { message: (error as Error)?.message || String(error) }), 5000));
}

document.addEventListener("mousemove", onDocumentMouseMove, true);
document.addEventListener("mouseup", onDocumentMouseUp, true);

onBeforeUnmount(() => {
  document.removeEventListener("mousemove", onDocumentMouseMove, true);
  document.removeEventListener("mouseup", onDocumentMouseUp, true);
  window.clearTimeout(clearSuppressTimer);
  resetDragState();
});

function handleDragMouseDown(event: MouseEvent, id: string, type: Extract<DragItemType, "folder" | "task">) {
  if (event.button !== 0) return;
  if (event.shiftKey || event.metaKey || event.ctrlKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("[data-no-drag='true']")) return;
  pendingDrag = {
    id,
    type,
    startX: event.clientX,
    startY: event.clientY,
    sourceEl: event.currentTarget as HTMLElement,
  };
}

function updateDropTarget(event: MouseEvent, targetId: string, targetType: DragItemType) {
  if (!dragState.active || !dragState.draggedId || !dragState.draggedType) return;
  if (dragState.draggedId === targetId) {
    clearDropTarget(targetId);
    return;
  }

  let nextPosition: DropPosition | null = null;
  if (dragState.draggedType === "folder" && targetType === "folder") {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const y = event.clientY - rect.top;
    const third = rect.height / 3;
    nextPosition = y > third && y < rect.height - third ? "inside" : y < rect.height / 2 ? "before" : "after";
  } else if (dragState.draggedType === "task" && targetType === "task") {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    nextPosition = event.clientY - rect.top < rect.height / 2 ? "before" : "after";
  } else if (dragState.draggedType === "task" && (targetType === "folder" || targetType === "unfiled")) {
    nextPosition = "inside";
  }

  dragState.targetId = nextPosition ? targetId : null;
  dragState.targetType = nextPosition ? targetType : null;
  dragState.dropPosition = nextPosition;
}

function clearDropTarget(targetId: string) {
  if (dragState.targetId !== targetId) return;
  dragState.targetId = null;
  dragState.targetType = null;
  dragState.dropPosition = null;
}

function isDraggingItem(id: string) {
  return dragState.active && dragState.draggedId === id;
}

function showDropBefore(targetId: string) {
  return dragState.active && dragState.targetId === targetId && dragState.dropPosition === "before";
}

function showDropAfter(targetId: string) {
  return dragState.active && dragState.targetId === targetId && dragState.dropPosition === "after";
}

function showDropInside(targetId: string) {
  return dragState.active && dragState.targetId === targetId && dragState.dropPosition === "inside";
}

function onTaskClick(task: TransferTask) {
  if (suppressNextRowClick.value) return;
  emit("select", task);
}

function taskRowClass(taskId: string) {
  return props.selectedTaskId === taskId ? "bg-accent text-accent-foreground" : "hover:bg-muted/70";
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden bg-muted/10 select-none">
    <div class="h-9 flex items-center gap-1 px-2 border-b shrink-0 bg-muted/20">
      <span class="text-[13px] font-medium">{{ t("transfer.tasks.title") }}</span>
      <span class="flex-1" />
      <LightTooltip :text="t('transfer.tasks.newTask')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="requestNewBlank">
          <Plus class="h-3 w-3" />
        </Button>
      </LightTooltip>
      <LightTooltip :text="t('transfer.tasks.newFolder')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="openNewFolderInput()">
          <FolderPlus class="h-3 w-3" />
        </Button>
      </LightTooltip>
    </div>

    <div class="border-b shrink-0 px-2 py-1">
      <div class="relative">
        <Search class="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        <input v-model="searchText" autocapitalize="off" autocorrect="off" spellcheck="false" class="w-full h-6 pl-7 pr-6 text-[13px] rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring" :placeholder="t('transfer.tasks.searchTasks')" />
        <button v-if="searchText" type="button" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="searchText = ''">
          <X class="h-3 w-3" />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto py-1">
      <CustomContextMenu :items="() => contextMenuItems" @close="clearContextTarget">
        <template #default="{ onContextMenu }">
          <div
            class="h-full"
            @contextmenu.capture="contextTarget = 'panel'"
            @contextmenu.prevent="
              contextTarget = 'panel';
              onContextMenu($event);
            "
          >
            <div v-for="row in visibleFolderRows" :key="row.type === 'folder' ? row.folder.id : row.task.id">
              <div
                v-if="row.type === 'folder'"
                class="relative flex cursor-default items-center gap-1 py-1.5 pr-2 text-[13px] group"
                :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
                :class="[showDropInside(row.folder.id) ? 'ring-1 ring-primary/50 bg-primary/5' : 'hover:bg-muted/70', isDraggingItem(row.folder.id) ? 'opacity-50' : '']"
                @mousedown="handleDragMouseDown($event, row.folder.id, 'folder')"
                @mousemove="updateDropTarget($event, row.folder.id, 'folder')"
                @mouseleave="clearDropTarget(row.folder.id)"
                @click="toggleFolder(row.folder.id)"
                @contextmenu.capture="contextTarget = row.folder"
                @contextmenu.prevent="
                  contextTarget = row.folder;
                  onContextMenu($event);
                "
              >
                <div v-if="showDropBefore(row.folder.id)" class="absolute left-2 right-2 top-0 border-t-2 border-primary" />
                <div v-if="showDropAfter(row.folder.id)" class="absolute left-2 right-2 bottom-0 border-b-2 border-primary" />
                <ChevronRight class="h-3 w-3 text-muted-foreground/80 transition-transform duration-200 shrink-0" :class="{ 'rotate-90': isFolderExpanded(row.folder.id) }" />
                <component :is="isFolderExpanded(row.folder.id) ? FolderOpen : FolderClosed" class="h-4 w-4 text-amber-500 shrink-0" />
                <template v-if="isRenamingFolder(row.folder.id)">
                  <input
                    :ref="setRenameInputRef"
                    v-model="renameValue"
                    data-no-drag="true"
                    class="min-w-0 flex-1 rounded border border-primary/50 bg-transparent px-1 text-[13px] outline-none"
                    @keydown.enter.prevent="confirmRename"
                    @keydown.escape.prevent="cancelRename"
                    @blur="confirmRename"
                    @mousedown.stop
                    @click.stop
                  />
                </template>
                <span v-else class="dbx-transfer-task-drag-label min-w-0 flex-1 truncate">
                  {{ row.folder.name }}
                  <span class="ml-1 text-muted-foreground">({{ folderTaskCount(row.folder.id) }})</span>
                </span>
              </div>

              <div
                v-else
                class="relative flex cursor-default items-center gap-1 py-1.5 pr-2 text-[13px] group"
                :style="{ paddingLeft: `${8 + row.depth * 16}px` }"
                :class="[taskRowClass(row.task.id), isDraggingItem(row.task.id) ? 'opacity-50' : '']"
                @mousedown="handleDragMouseDown($event, row.task.id, 'task')"
                @mousemove="updateDropTarget($event, row.task.id, 'task')"
                @mouseleave="clearDropTarget(row.task.id)"
                @click="onTaskClick(row.task)"
                @contextmenu.capture="contextTarget = row.task"
                @contextmenu.prevent="
                  contextTarget = row.task;
                  onContextMenu($event);
                "
              >
                <div v-if="showDropBefore(row.task.id)" class="absolute left-2 right-2 top-0 border-t-2 border-primary" />
                <div v-if="showDropAfter(row.task.id)" class="absolute left-2 right-2 bottom-0 border-b-2 border-primary" />
                <ArrowRightLeft class="h-3.5 w-3.5 text-blue-400 shrink-0" />
                <template v-if="isRenamingTask(row.task.id)">
                  <input
                    :ref="setRenameInputRef"
                    v-model="renameValue"
                    data-no-drag="true"
                    class="min-w-0 flex-1 rounded border border-primary/50 bg-transparent px-1 text-[13px] outline-none"
                    @keydown.enter.prevent="confirmRename"
                    @keydown.escape.prevent="cancelRename"
                    @blur="confirmRename"
                    @mousedown.stop
                    @click.stop
                  />
                </template>
                <span v-else class="dbx-transfer-task-drag-label min-w-0 flex-1 truncate" :title="`${row.task.config.sourceDatabase} → ${row.task.config.targetDatabase}`">{{ row.task.name }}</span>
              </div>
            </div>

            <div v-if="visibleRootTasks.length > 0 || dragState.draggedType === 'task'">
              <div
                v-if="dragState.draggedType === 'task' && (visibleFolderRows.length > 0 || searchQuery)"
                class="relative px-2 py-1 text-[10px] font-medium uppercase text-muted-foreground"
                :class="showDropInside(UNFILED_DROP_TARGET_ID) ? 'ring-1 ring-primary/50 bg-primary/5' : ''"
                @mousemove="updateDropTarget($event, UNFILED_DROP_TARGET_ID, 'unfiled')"
                @mouseleave="clearDropTarget(UNFILED_DROP_TARGET_ID)"
              >
                {{ t("transfer.tasks.ungrouped") }}
              </div>
              <div
                v-for="task in visibleRootTasks"
                :key="task.id"
                class="relative flex cursor-default items-center gap-1 px-2 py-1.5 text-[13px] group"
                :class="[taskRowClass(task.id), isDraggingItem(task.id) ? 'opacity-50' : '']"
                @mousedown="handleDragMouseDown($event, task.id, 'task')"
                @mousemove="updateDropTarget($event, task.id, 'task')"
                @mouseleave="clearDropTarget(task.id)"
                @click="onTaskClick(task)"
                @contextmenu.capture="contextTarget = task"
                @contextmenu.prevent="
                  contextTarget = task;
                  onContextMenu($event);
                "
              >
                <div v-if="showDropBefore(task.id)" class="absolute left-2 right-2 top-0 border-t-2 border-primary" />
                <div v-if="showDropAfter(task.id)" class="absolute left-2 right-2 bottom-0 border-b-2 border-primary" />
                <ArrowRightLeft class="h-3.5 w-3.5 text-blue-400 shrink-0" />
                <template v-if="isRenamingTask(task.id)">
                  <input
                    :ref="setRenameInputRef"
                    v-model="renameValue"
                    data-no-drag="true"
                    class="min-w-0 flex-1 rounded border border-primary/50 bg-transparent px-1 text-[13px] outline-none"
                    @keydown.enter.prevent="confirmRename"
                    @keydown.escape.prevent="cancelRename"
                    @blur="confirmRename"
                    @mousedown.stop
                    @click.stop
                  />
                </template>
                <span v-else class="dbx-transfer-task-drag-label min-w-0 flex-1 truncate" :title="`${task.config.sourceDatabase} → ${task.config.targetDatabase}`">{{ task.name }}</span>
              </div>
            </div>

            <div v-if="!hasAnyVisibleItem" class="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <ArrowRightLeft class="h-8 w-8 opacity-30" />
              <p class="text-[13px]">{{ t("transfer.tasks.empty") }}</p>
            </div>
          </div>
        </template>
      </CustomContextMenu>
    </div>

    <Dialog v-model:open="showDeleteConfirm">
      <DialogContent class="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle v-if="deleteTarget?.type === 'folder'">{{ t("transfer.tasks.deleteFolderTitle") }}</DialogTitle>
          <DialogTitle v-else>{{ t("transfer.tasks.deleteTaskTitle") }}</DialogTitle>
          <DialogDescription v-if="deleteTarget?.type === 'folder'">
            {{ t("transfer.tasks.deleteFolderConfirm", { name: deleteTarget?.name || "" }) }}
          </DialogDescription>
          <DialogDescription v-else>
            {{ t("transfer.tasks.deleteTaskConfirm", { name: deleteTarget?.name || "" }) }}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" @click="showDeleteConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" size="sm" @click="executeDelete">{{ t("dangerDialog.confirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
