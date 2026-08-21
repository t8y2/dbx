<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const value = defineModel<string>("value", { default: "" });
const scope = defineModel<"selection" | "condition">("scope", { default: "selection" });
const conditionSource = defineModel<"current" | "builder" | "sql">("conditionSource", { default: "builder" });
const whereInput = defineModel<string>("whereInput", { default: "" });
defineProps<{
  selectedCellCount: number;
  conditionalAvailable?: boolean;
  conditionalColumn?: string;
  currentWhere?: string;
  conditionalCount?: number;
  conditionalCountLoading?: boolean;
  conditionalCountError?: string;
  conditionalCountStale?: boolean;
}>();
const emit = defineEmits<{ apply: []; previewCount: [] }>();

const dragOffset = ref({ x: 0, y: 0 });
const isDragging = ref(false);
const dragStartPosition = ref({ x: 0, y: 0 });
const dragStartOffset = ref({ x: 0, y: 0 });
const activePointerId = ref<number | null>(null);
const dialogContentStyle = computed(() => {
  if (isDragging.value || dragOffset.value.x !== 0 || dragOffset.value.y !== 0) {
    return {
      transform: `translate(${dragOffset.value.x}px, ${dragOffset.value.y}px)`,
      transition: isDragging.value ? "none" : "transform 0.15s ease-out",
    };
  }
  return {};
});

function resetDialogDragOffset() {
  dragOffset.value = { x: 0, y: 0 };
  isDragging.value = false;
  activePointerId.value = null;
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

watch(open, (isOpen) => {
  if (isOpen) {
    void nextTick(resetDialogDragOffset);
  } else {
    resetDialogDragOffset();
  }
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :style="dialogContentStyle" class="sm:max-w-[680px]">
      <DialogHeader class="cursor-move select-none" @pointerdown="startDialogDrag" @pointermove="moveDialogDrag" @pointerup="endDialogDrag" @pointercancel="endDialogDrag"
        ><DialogTitle>{{ t("grid.bulkEditTitle") }}</DialogTitle></DialogHeader
      >
      <div class="space-y-2">
        <div v-if="conditionalAvailable" class="grid gap-2 pb-1">
          <button type="button" class="rounded-md border px-3 py-2 text-left transition-colors" :class="scope === 'selection' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'" @click="scope = 'selection'">
            <span class="block text-sm font-medium">{{ t("grid.bulkEditSelectionScope") }}</span>
            <span class="mt-0.5 block text-xs text-muted-foreground">{{ t("grid.bulkEditSelectionScopeDescription", { count: selectedCellCount }) }}</span>
          </button>
          <button type="button" class="rounded-md border px-3 py-2 text-left transition-colors" :class="scope === 'condition' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'" @click="scope = 'condition'">
            <span class="block text-sm font-medium">{{ t("grid.bulkEditConditionalScope") }}</span>
            <span class="mt-0.5 block text-xs text-muted-foreground">{{ t("grid.bulkEditConditionalScopeDescription", { column: conditionalColumn }) }}</span>
          </button>
        </div>
        <p v-else class="text-sm text-muted-foreground">{{ t("grid.bulkEditDescription", { count: selectedCellCount }) }}</p>
        <div v-if="scope === 'condition'" class="space-y-2">
          <div class="text-sm font-medium">{{ t("grid.bulkEditConditionalConditionSource") }}</div>
          <div class="grid gap-2" :class="currentWhere ? 'sm:grid-cols-3' : 'sm:grid-cols-2'">
            <button v-if="currentWhere" type="button" class="rounded-md border px-3 py-2 text-left transition-colors" :class="conditionSource === 'current' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'" @click="conditionSource = 'current'">
              <span class="block text-sm font-medium">{{ t("grid.bulkEditConditionalUseCurrentFilter") }}</span>
              <span class="mt-0.5 block text-xs text-muted-foreground">{{ t("grid.bulkEditConditionalUseCurrentFilterDescription") }}</span>
            </button>
            <button type="button" class="rounded-md border px-3 py-2 text-left transition-colors" :class="conditionSource === 'builder' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'" @click="conditionSource = 'builder'">
              <span class="block text-sm font-medium">{{ t("grid.bulkEditConditionalBuildFilter") }}</span>
              <span class="mt-0.5 block text-xs text-muted-foreground">{{ t("grid.bulkEditConditionalBuildFilterDescription") }}</span>
            </button>
            <button type="button" class="rounded-md border px-3 py-2 text-left transition-colors" :class="conditionSource === 'sql' ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'" @click="conditionSource = 'sql'">
              <span class="block text-sm font-medium">{{ t("grid.bulkEditConditionalAdvancedWhere") }}</span>
              <span class="mt-0.5 block text-xs text-muted-foreground">{{ t("grid.bulkEditConditionalAdvancedWhereDescription") }}</span>
            </button>
          </div>
          <div v-if="conditionSource === 'current' && currentWhere" class="rounded-md bg-muted/60 px-2.5 py-2">
            <code class="block max-h-20 overflow-auto whitespace-pre-wrap break-all text-xs">{{ currentWhere }}</code>
          </div>
          <div v-else-if="conditionSource === 'builder'" class="max-h-72 overflow-auto rounded-md border bg-muted/10 p-2">
            <slot name="condition-builder" />
          </div>
          <template v-else>
            <label class="text-sm font-medium" for="bulk-edit-where-input">{{ t("grid.bulkEditConditionalWhere") }}</label>
            <textarea
              id="bulk-edit-where-input"
              v-model="whereInput"
              autocapitalize="off"
              autocomplete="off"
              autocorrect="off"
              spellcheck="false"
              rows="3"
              class="dbx-data-grid-value-font min-h-20 w-full min-w-0 resize-y rounded-[6px] border border-input bg-transparent px-2.5 py-1.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
              :placeholder="t('grid.bulkEditConditionalWherePlaceholder')"
            />
            <p class="text-xs text-muted-foreground">{{ t("grid.bulkEditConditionalWhereDescription") }}</p>
          </template>
          <div class="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="outline" size="sm" :disabled="conditionalCountLoading" @click="emit('previewCount')">
              {{ conditionalCountLoading ? t("grid.conditionalBulkEditPreviewingCount") : t("grid.conditionalBulkEditPreviewCount") }}
            </Button>
            <span v-if="conditionalCount !== undefined" class="text-sm font-medium text-foreground">{{ t("grid.conditionalBulkEditPreviewCountResult", { count: conditionalCount }) }}</span>
            <span v-else-if="conditionalCountStale" class="text-xs text-muted-foreground">{{ t("grid.conditionalBulkEditPreviewCountStale") }}</span>
          </div>
          <p v-if="conditionalCountError" class="text-xs text-destructive">{{ conditionalCountError }}</p>
        </div>
        <textarea
          v-model="value"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          rows="5"
          class="dbx-data-grid-value-font min-h-24 w-full min-w-0 resize-y rounded-[6px] border border-input bg-transparent px-2.5 py-1.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
          :placeholder="t('grid.bulkEditValuePlaceholder')"
          @keydown.ctrl.enter.prevent="emit('apply')"
          @keydown.meta.enter.prevent="emit('apply')"
        />
      </div>
      <DialogFooter
        ><Button variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button
        ><Button @click="emit('apply')">{{ t("grid.applyBulkEdit") }}</Button></DialogFooter
      >
    </DialogContent>
  </Dialog>
</template>
