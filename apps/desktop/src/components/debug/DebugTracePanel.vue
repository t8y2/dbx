<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Play, Square } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { usePlDebugStore } from "@/stores/plDebugStore";

/**
 * 逐行跟踪面板：把停靠中的程序用单步跑到结束，记录每一行跑了多少次。
 *
 * 这是"哪些行真的执行过"的直接答案（PLSDev 的 Trace 窗口用 DBMS_TRACE 达到同一目的，
 * 而本机 19c 上 DBMS_TRACE 只写服务器跟踪文件、DBMS_PROFILER 缺表 —— 见总表 §2 #35）。
 * 每次单步都是一次往返，所以有 1000 步上限、并且可以在步与步之间停下。
 */
const { t } = useI18n();
const store = usePlDebugStore();

const canStart = computed(() => store.hasSession && store.terminated !== true && store.traceRunning !== true && store.busy !== true);
const summary = computed(() => {
  const result = store.traceResult;
  if (!result) return "";
  return t("plDebug.trace.summary", {
    steps: result.steps,
    lines: result.lines.length,
    ms: result.durationMs,
  });
});
</script>

<template>
  <div class="flex h-full flex-col gap-1 p-2">
    <div class="flex items-center gap-2">
      <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs" :disabled="!canStart" :title="t('plDebug.trace.start')" @click="store.startTrace()">
        <Play class="h-3.5 w-3.5" />
        {{ t("plDebug.trace.start") }}
      </Button>
      <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs" :disabled="store.traceRunning !== true" :title="t('plDebug.trace.stop')" @click="store.stopTrace()">
        <Square class="h-3.5 w-3.5" />
        {{ t("plDebug.trace.stop") }}
      </Button>
      <span v-if="store.traceRunning" class="text-[11px] text-muted-foreground">{{ t("plDebug.trace.running") }}</span>
    </div>
    <p class="text-[11px] text-muted-foreground">{{ t("plDebug.trace.hint") }}</p>
    <p v-if="summary" class="text-[11px] text-muted-foreground">{{ summary }}</p>
    <p v-if="store.traceResult?.truncated" class="text-[11px] text-amber-600 dark:text-amber-400">{{ t("plDebug.trace.truncated") }}</p>
    <div class="min-h-0 flex-1 overflow-auto">
      <table v-if="store.traceResult && store.traceResult.lines.length > 0" class="w-full text-xs">
        <thead class="sticky top-0 bg-background">
          <tr class="text-left text-muted-foreground">
            <th class="w-20 px-2 py-1 font-normal">{{ t("plDebug.trace.line") }}</th>
            <th class="w-20 px-2 py-1 font-normal">{{ t("plDebug.trace.hits") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in store.traceResult.lines" :key="row.line" class="border-t">
            <td class="px-2 py-1 align-top font-mono">{{ row.line }}</td>
            <td class="px-2 py-1 align-top font-mono">{{ row.hits }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="px-2 py-3 text-center text-xs text-muted-foreground">{{ t("plDebug.trace.empty") }}</p>
    </div>
  </div>
</template>
