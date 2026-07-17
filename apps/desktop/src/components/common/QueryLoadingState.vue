<script setup lang="ts">
import { Loader2, Square } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";

withDefaults(
  defineProps<{
    labelKey?: string;
    elapsedSeconds?: number | string;
    showCancel?: boolean;
    cancelDisabled?: boolean;
    cancelling?: boolean;
    cancelLabelKey?: string;
  }>(),
  {
    labelKey: "common.loading",
    elapsedSeconds: undefined,
    showCancel: false,
    cancelDisabled: false,
    cancelling: false,
    cancelLabelKey: "toolbar.stopQuery",
  },
);

const emit = defineEmits<{
  cancel: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
    <div class="flex items-center">
      <Loader2 class="h-5 w-5 animate-spin mr-2" />
      {{ t(labelKey) }}
      <span v-if="elapsedSeconds !== undefined" class="ml-1 tabular-nums text-muted-foreground/80">· {{ elapsedSeconds }}s</span>
    </div>
    <Button v-if="showCancel" variant="destructive" size="sm" class="query-loading-cancel-button h-7 gap-1.5" :disabled="cancelDisabled" @click="emit('cancel')">
      <Loader2 v-if="cancelling" class="h-3.5 w-3.5 animate-spin" />
      <Square v-else class="h-3.5 w-3.5 fill-current" />
      {{ t(cancelLabelKey) }}
    </Button>
  </div>
</template>

<style>
.query-loading-cancel-button {
  border: 1px solid rgba(220, 38, 38, 0.22) !important;
  background-color: rgba(220, 38, 38, 0.08) !important;
  color: rgb(185, 28, 28) !important;
}

.query-loading-cancel-button:hover {
  background-color: rgba(220, 38, 38, 0.14) !important;
}

.dark .query-loading-cancel-button {
  border-color: rgba(248, 113, 113, 0.28) !important;
  background-color: rgba(248, 113, 113, 0.12) !important;
  color: rgb(248, 113, 113) !important;
}
</style>
