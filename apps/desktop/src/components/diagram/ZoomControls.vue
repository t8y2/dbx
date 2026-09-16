<script setup lang="ts">
import { useVueFlow } from "@vue-flow/core";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize2, RotateCcw, Undo2, Redo2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

defineProps<{
  canUndo?: boolean;
  canRedo?: boolean;
}>();

const emit = defineEmits<{
  (e: "undo"): void;
  (e: "redo"): void;
}>();

const { t } = useI18n();
const { zoomIn: vfZoomIn, zoomOut: vfZoomOut, fitView } = useVueFlow();

const FIT_OPTIONS = { padding: 0.15, duration: 150, minZoom: 0.05, maxZoom: 2 } as const;

function zoomIn() {
  vfZoomIn({ duration: 150 });
}

function zoomOut() {
  vfZoomOut({ duration: 150 });
}

function resetZoom() {
  void fitView({ ...FIT_OPTIONS });
}

function fitToView() {
  void fitView({ ...FIT_OPTIONS });
}
</script>

<template>
  <div class="absolute bottom-3 left-3 z-50 flex flex-col items-center gap-1">
    <Button variant="outline" size="icon" class="h-7 w-7" :title="t('diagram.undo')" :disabled="!canUndo" @click="emit('undo')">
      <Undo2 class="h-3.5 w-3.5" />
    </Button>
    <Button variant="outline" size="icon" class="h-7 w-7" :title="t('diagram.redo')" :disabled="!canRedo" @click="emit('redo')">
      <Redo2 class="h-3.5 w-3.5" />
    </Button>
    <div class="w-px h-1 bg-border my-1" />
    <Button variant="outline" size="icon" class="h-7 w-7" :title="t('diagram.zoomIn')" @click="zoomIn">
      <ZoomIn class="h-3.5 w-3.5" />
    </Button>
    <Button variant="outline" size="icon" class="h-7 w-7" :title="t('diagram.zoomOut')" @click="zoomOut">
      <ZoomOut class="h-3.5 w-3.5" />
    </Button>
    <div class="w-px h-1 bg-border my-1" />
    <Button variant="outline" size="icon" class="h-7 w-7" :title="t('diagram.fitView')" @click="fitToView">
      <Maximize2 class="h-3.5 w-3.5" />
    </Button>
    <Button variant="outline" size="icon" class="h-7 w-7" :title="t('diagram.resetZoom')" @click="resetZoom">
      <RotateCcw class="h-3.5 w-3.5" />
    </Button>
  </div>
</template>
