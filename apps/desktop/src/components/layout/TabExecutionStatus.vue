<script setup lang="ts">
import { computed } from "vue";
import { Loader2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { queryExecutionLabelKey } from "@/lib/sql/queryExecutionState";
import type { QueryTab } from "@/types/database";

const props = defineProps<{
  tab: Pick<QueryTab, "mode" | "isExecuting" | "isCancelling" | "sourceLoad">;
}>();

const { t } = useI18n();
// 源码加载中（issue #9035）与查询执行中共用这一个 tab 栏转圈：两者都是
// 「这个 tab 正在等后端」，用户需要的反馈是同一种。
const status = computed<"running" | "cancelling" | "source-loading" | undefined>(() => {
  if (props.tab.mode !== "query") return undefined;
  if (props.tab.sourceLoad && !props.tab.sourceLoad.error) return "source-loading";
  if (!props.tab.isExecuting) return undefined;
  return props.tab.isCancelling ? "cancelling" : "running";
});

const labelKey = computed(() => (status.value === "source-loading" ? "common.loading" : queryExecutionLabelKey(props.tab)));
</script>

<template>
  <span v-if="status" data-tab-execution-status role="status" class="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" :class="status === 'cancelling' ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400'" :aria-label="t(labelKey)" :title="t(labelKey)">
    <Loader2 aria-hidden="true" class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
  </span>
  <slot v-else />
</template>
