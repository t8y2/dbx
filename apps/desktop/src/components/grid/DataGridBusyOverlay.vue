<script setup lang="ts">
import { computed } from "vue";
import { Loader2, Square } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { formatElapsedSeconds } from "@/lib/common/elapsedTime";
import type { QueryPageJumpProgress } from "@/types/database";

const props = withDefaults(
  defineProps<{
    /** Elapsed time of the current busy surface, in milliseconds. */
    elapsedMs: number;
    /** Multi-request page jump progress; renders the larger progress card. */
    pageJumpProgress?: QueryPageJumpProgress;
    /**
     * Shows the stop action. Off by default: loaders that call the backend
     * directly and cannot be cancelled keep the plain elapsed pill.
     */
    showCancel?: boolean;
    cancelling?: boolean;
    cancelDisabled?: boolean;
  }>(),
  {
    pageJumpProgress: undefined,
    showCancel: false,
    cancelling: false,
    cancelDisabled: false,
  },
);

const emit = defineEmits<{
  cancel: [];
}>();

const { t } = useI18n();

const pageJumpProgressPercent = computed(() => {
  const progress = props.pageJumpProgress;
  if (!progress) return 0;
  const total = Math.max(1, progress.totalRequests);
  return Math.max(0, Math.min(100, (progress.completedRequests / total) * 100));
});
</script>

<template>
  <div v-if="pageJumpProgress" class="w-72 max-w-[calc(100%-2rem)] rounded-lg border bg-background/95 p-3.5 shadow-lg">
    <div class="flex items-center gap-3">
      <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Loader2 class="h-4 w-4 animate-spin" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium text-foreground">{{ t("grid.pageJumpLoading", { page: pageJumpProgress.targetPage }) }}</div>
        <div class="mt-0.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span>{{ t("grid.pageJumpProgress", { current: pageJumpProgress.completedRequests, total: pageJumpProgress.totalRequests }) }}</span>
          <span class="shrink-0 tabular-nums">{{ formatElapsedSeconds(elapsedMs) }}s</span>
        </div>
      </div>
    </div>
    <div class="mt-3 flex items-center gap-2">
      <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" :aria-valuemin="0" :aria-valuemax="pageJumpProgress.totalRequests" :aria-valuenow="pageJumpProgress.completedRequests">
        <div class="h-full rounded-full bg-primary transition-[width] duration-200 ease-out" :style="{ width: `${pageJumpProgressPercent}%` }" />
      </div>
      <Button v-if="showCancel" variant="destructive" size="sm" class="data-grid-loading-cancel-button h-6 shrink-0 gap-1 px-2 text-xs" :disabled="cancelDisabled || cancelling" @click="emit('cancel')">
        <Loader2 v-if="cancelling" class="h-3 w-3 animate-spin" />
        <Square v-else class="h-3 w-3 fill-current" />
        {{ t(cancelling ? "common.stopping" : "toolbar.stopQuery") }}
      </Button>
    </div>
  </div>
  <div v-else class="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
    <Loader2 class="w-3.5 h-3.5 animate-spin" />
    <span class="tabular-nums">{{ formatElapsedSeconds(elapsedMs) }}s</span>
    <Button v-if="showCancel" variant="destructive" size="sm" class="data-grid-loading-cancel-button h-6 shrink-0 gap-1 px-2 text-xs" :disabled="cancelDisabled || cancelling" @click="emit('cancel')">
      <Loader2 v-if="cancelling" class="h-3 w-3 animate-spin" />
      <Square v-else class="h-3 w-3 fill-current" />
      {{ t(cancelling ? "common.stopping" : "toolbar.stopQuery") }}
    </Button>
  </div>
</template>
