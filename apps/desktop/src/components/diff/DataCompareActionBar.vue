<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Copy, GitCompareArrows, Loader2, Play, RotateCcw } from "@lucide/vue";

const props = defineProps<{
  hasResults: boolean;
  canCompare: boolean;
  comparing: boolean;
  executionLocked: boolean;
  executing: boolean;
  resolvingTransaction: boolean;
  transactionFailed: boolean;
  planningSync: boolean;
  canUseManualTransaction: boolean;
  /** A manual transaction is open (pending commit/rollback). */
  transactionActive: boolean;
  manualTransaction: boolean;
  compareProgressLabel: string;
  executedCount: number;
  executeTotal: number;
  hasSyncSql: boolean;
  statementCount: number;
  insertCount: number;
  updateCount: number;
  deleteCount: number;
}>();

const emit = defineEmits<{
  compare: [];
  "copy-sql": [];
  execute: [];
  rollback: [];
  commit: [];
  "update:manualTransaction": [value: boolean];
}>();

const { t } = useI18n();
</script>

<template>
  <template v-if="!props.hasResults">
    <span v-if="props.compareProgressLabel" class="text-xs text-muted-foreground self-center">{{ props.compareProgressLabel }}</span>
    <Button size="sm" :disabled="!props.canCompare || props.comparing" @click="emit('compare')">
      <Loader2 v-if="props.comparing" class="w-3.5 h-3.5 animate-spin mr-1" />
      <GitCompareArrows v-else class="w-3.5 h-3.5 mr-1" />
      {{ t("dataCompare.compare") }}
    </Button>
  </template>

  <template v-else>
    <Button variant="outline" size="sm" :disabled="props.comparing || props.executionLocked || !props.canCompare" @click="emit('compare')">
      <Loader2 v-if="props.comparing" class="w-3 h-3 animate-spin mr-1" />
      <RotateCcw v-else class="w-3 h-3 mr-1" />
      {{ t("dataCompare.recompare") }}
    </Button>
    <span v-if="props.comparing" class="text-xs text-muted-foreground mr-auto">{{ props.compareProgressLabel || t("diff.progress.comparing") }}</span>
    <span v-else-if="props.executing" class="text-xs text-muted-foreground mr-auto">
      {{ t("diff.syncProgress", { current: props.executedCount, total: props.executeTotal }) }}
    </span>
    <span v-else-if="props.planningSync" class="text-xs text-muted-foreground mr-auto">
      {{ t("dataCompare.planningSync") }}
    </span>
    <span v-else class="text-xs text-muted-foreground mr-auto">
      {{
        t("dataCompare.planSummary", {
          inserts: props.insertCount,
          updates: props.updateCount,
          deletes: props.deleteCount,
          statements: props.statementCount,
        })
      }}
    </span>
    <Button variant="outline" size="sm" :disabled="!props.hasSyncSql" @click="emit('copy-sql')"> <Copy class="w-3 h-3 mr-1" /> {{ t("diff.copySql") }} </Button>
    <template v-if="props.transactionActive && !props.executing">
      <span class="text-xs text-muted-foreground">{{ t("dataCompare.pendingTransaction") }}</span>
      <Button variant="outline" size="sm" :disabled="props.resolvingTransaction" @click="emit('rollback')">{{ t("toolbar.rollback") }}</Button>
      <Button size="sm" :disabled="props.resolvingTransaction || props.transactionFailed" @click="emit('commit')">{{ t("toolbar.commit") }}</Button>
    </template>
    <label v-else-if="props.canUseManualTransaction" class="flex items-center gap-2 text-xs" :title="t('dataCompare.manualTransactionHint')">
      <input :checked="props.manualTransaction" type="checkbox" :disabled="props.executionLocked" @change="emit('update:manualTransaction', ($event.target as HTMLInputElement).checked)" />
      {{ t("toolbar.manualTransaction") }}
    </label>
    <Button v-if="!props.transactionActive" size="sm" :disabled="props.planningSync || props.comparing || props.executionLocked || props.statementCount === 0" @click="emit('execute')">
      <Loader2 v-if="props.executing" class="w-3 h-3 animate-spin mr-1" />
      <Play v-else class="w-3 h-3 mr-1" />
      {{ t("diff.executeSync") }}
    </Button>
  </template>
</template>
