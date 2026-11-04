<script setup lang="ts">
import { computed, ref, type Component } from "vue";
import { ChevronLeft, ChevronRight, GripVertical, RotateCcw, Play, FastForward, SquarePlay, Eye, GitBranch, AlignLeft, Minimize2, FoldVertical, UnfoldVertical, SpellCheck2, WrapText, BetweenVerticalStart, Save, FolderOpen, Download, ClipboardPaste, CirclePlay } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_EDITOR_TOOLBAR_ORDER, REQUIRED_EDITOR_TOOLBAR_ACTIONS, moveEditorToolbarAction, normalizeEditorToolbarHiddenActions, normalizeEditorToolbarOrder, type EditorToolbarActionId } from "@/lib/editor/editorToolbarPreferences";

const props = withDefaults(defineProps<{ wordWrap?: boolean; semanticDiagnostics?: boolean; insertValueHints?: boolean }>(), {
  wordWrap: false,
  semanticDiagnostics: true,
  insertValueHints: true,
});

const order = defineModel<EditorToolbarActionId[]>("order", { required: true });
const hiddenActions = defineModel<EditorToolbarActionId[]>("hiddenActions", { required: true });
const { t } = useI18n();
const dragging = ref<EditorToolbarActionId>();
const normalizedOrder = computed(() => normalizeEditorToolbarOrder(order.value));
const actionIcons = {
  execute: Play,
  "execute-all": FastForward,
  "execute-in-new-result-tab": SquarePlay,
  "preview-changes": Eye,
  explain: GitBranch,
  format: AlignLeft,
  compress: Minimize2,
  "fold-all": FoldVertical,
  "unfold-all": UnfoldVertical,
  "keyword-case": SpellCheck2,
  "word-wrap": WrapText,
  "semantic-diagnostics": SpellCheck2,
  "insert-value-hints": BetweenVerticalStart,
  save: Save,
  "open-sql": FolderOpen,
  "import-result-archive": Download,
  "paste-sql-condition": ClipboardPaste,
  "multi-execute": CirclePlay,
} satisfies Record<EditorToolbarActionId, Component>;
// Normal, idle toolbar colors. Connection-specific production/running states do not apply to settings.
const actionColors: Record<EditorToolbarActionId, string> = {
  execute: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  "execute-all": "text-emerald-600 dark:text-emerald-300",
  "execute-in-new-result-tab": "text-violet-600 dark:text-violet-300",
  "preview-changes": "text-sky-600",
  explain: "text-violet-600 dark:text-violet-300",
  format: "text-amber-600 dark:text-amber-300",
  compress: "text-amber-600 dark:text-amber-300",
  "fold-all": "text-muted-foreground",
  "unfold-all": "text-muted-foreground",
  "keyword-case": "font-mono text-sm font-semibold text-amber-600/70 dark:text-amber-300/70",
  "word-wrap": "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  "semantic-diagnostics": "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  "insert-value-hints": "bg-sky-500/10 text-sky-600 dark:text-sky-300",
  save: "text-blue-600 dark:text-blue-300",
  "open-sql": "text-sky-600 dark:text-sky-300",
  "import-result-archive": "text-cyan-600 dark:text-cyan-300",
  "paste-sql-condition": "text-teal-600 dark:text-teal-300",
  "multi-execute": "text-primary",
};
function iconClass(id: EditorToolbarActionId): string {
  if ((id === "word-wrap" && !props.wordWrap) || (id === "semantic-diagnostics" && !props.semanticDiagnostics) || (id === "insert-value-hints" && !props.insertValueHints)) return "text-muted-foreground/50";
  return actionColors[id];
}
const dropTarget = ref<EditorToolbarActionId>();
const dropAfter = ref(false);
const required = new Set<EditorToolbarActionId>(REQUIRED_EDITOR_TOOLBAR_ACTIONS);

function label(id: EditorToolbarActionId): string {
  return t(`settings.editorToolbarAction.${id}`);
}

function isVisible(id: EditorToolbarActionId): boolean {
  return !normalizeEditorToolbarHiddenActions(hiddenActions.value).includes(id);
}

function setVisible(id: EditorToolbarActionId, visible: boolean) {
  if (required.has(id)) return;
  const hidden = new Set(normalizeEditorToolbarHiddenActions(hiddenActions.value));
  if (visible) hidden.delete(id);
  else hidden.add(id);
  hiddenActions.value = [...hidden];
}

function move(id: EditorToolbarActionId, direction: "up" | "down") {
  order.value = moveEditorToolbarAction(order.value, id, direction);
}

function startDrag(event: DragEvent, id: EditorToolbarActionId) {
  dragging.value = id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  }
}

function updateDropTarget(event: DragEvent, id: EditorToolbarActionId) {
  if (!dragging.value) return;
  event.preventDefault();
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dropTarget.value = id;
  dropAfter.value = event.clientX >= bounds.left + bounds.width / 2;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function endDrag() {
  dragging.value = undefined;
  dropTarget.value = undefined;
  dropAfter.value = false;
}

function drop(event: DragEvent, target: EditorToolbarActionId) {
  updateDropTarget(event, target);
  const source = dragging.value;
  const after = dropAfter.value;
  endDrag();
  if (!source || source === target) return;
  const next = normalizeEditorToolbarOrder(order.value).filter((id) => id !== source);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
  order.value = next;
}

function restoreDefaults() {
  order.value = [...DEFAULT_EDITOR_TOOLBAR_ORDER];
  hiddenActions.value = [];
}
</script>

<template>
  <div class="space-y-3" data-editor-toolbar-preferences>
    <div class="text-sm font-medium text-muted-foreground" data-editor-toolbar-heading>{{ t("settings.editorToolbarPreferences") }}</div>
    <div class="settings-item rounded-md border bg-muted/20 px-3 py-2">
      <div class="flex items-start justify-between gap-4">
        <div class="space-y-1">
          <Label class="text-foreground" data-editor-toolbar-subheading>{{ t("settings.editorToolbarVisibilityAndOrder") }}</Label>
          <p class="text-xs text-muted-foreground">{{ t("settings.editorToolbarPreferencesDescription") }}</p>
        </div>
        <Button type="button" variant="outline" size="sm" class="h-7 shrink-0 gap-1.5" @click="restoreDefaults"> <RotateCcw class="h-3.5 w-3.5" />{{ t("settings.editorToolbarRestoreDefault") }} </Button>
      </div>
      <div class="mt-4 overflow-x-auto pb-3" data-editor-toolbar-scroll>
        <div class="flex w-max min-w-full gap-2 rounded-lg bg-muted/30 p-2" role="list" :aria-label="t('settings.editorToolbarPreferences')">
          <div
            v-for="(id, index) in normalizedOrder"
            :key="id"
            role="listitem"
            :data-toolbar-action="id"
            class="relative flex w-36 shrink-0 flex-col gap-3 rounded-md border bg-background p-3 transition-colors"
            :class="[dragging === id ? 'opacity-40' : '', !isVisible(id) ? 'bg-muted/40 text-muted-foreground' : '', dropTarget === id && dragging !== id ? (dropAfter ? 'border-r-primary border-r-2' : 'border-l-primary border-l-2') : '']"
            draggable="true"
            @dragstart="startDrag($event, id)"
            @dragend="endDrag"
            @dragover="updateDropTarget($event, id)"
            @dragleave="dropTarget === id && (dropTarget = undefined)"
            @drop.prevent="drop($event, id)"
          >
            <div class="flex items-center justify-between gap-2">
              <GripVertical class="h-3.5 w-3.5 cursor-grab text-muted-foreground active:cursor-grabbing" aria-hidden="true" />
              <Switch :id="`editor-toolbar-${id}`" :aria-label="label(id)" :model-value="isVisible(id)" :disabled="required.has(id)" @update:model-value="setVisible(id, $event)" />
            </div>
            <Label :for="`editor-toolbar-${id}`" class="flex min-h-16 flex-col items-center justify-center gap-2 text-center text-xs leading-4">
              <span class="flex h-6 w-6 items-center justify-center rounded-md" :class="iconClass(id)" data-toolbar-action-icon aria-hidden="true">
                <span v-if="id === 'keyword-case'">A</span>
                <component :is="actionIcons[id]" v-else class="h-3.5 w-3.5 shrink-0" />
              </span>
              <span>{{ label(id) }}</span>
            </Label>
            <div class="flex items-center justify-between">
              <Button type="button" variant="ghost" size="icon" class="h-6 w-6" :disabled="index === 0" :aria-label="t('settings.editorToolbarMoveLeft')" @click="move(id, 'up')">
                <ChevronLeft class="h-3.5 w-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="icon" class="h-6 w-6" :disabled="index === normalizedOrder.length - 1" :aria-label="t('settings.editorToolbarMoveRight')" @click="move(id, 'down')">
                <ChevronRight class="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
