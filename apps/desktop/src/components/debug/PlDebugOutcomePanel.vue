<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { usePlDebugStore } from "@/stores/plDebugStore";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { PlDebugResultReference } from "@/lib/backend/pl-debug-tauri";
import PlDebugResultValue from "./PlDebugResultValue.vue";

/**
 * OUT 参数与函数返回值（目标**正常跑完后**才由 agent 报出）。
 *
 * 刻意与用户变量分开：变量是「当前帧里现在能看到什么」，在一次停顿时就有；OUT/返回值
 * 是「这次运行的结果」，只在目标结束时出现一次。混进变量表会让「程序运行中，暂无可见
 * 变量」与结论文本互相矛盾。
 *
 * 值全部按后端原文展示（不做任何引用/转义改写），并配复制按钮：等宽 + 可复制是这类
 * "运行结果"最容易想复制走的部分。
 */
const { t } = useI18n();
const store = usePlDebugStore();
/** Which copy button just ran, so the toolbar can confirm it (`all` for the header one). */
const copied = ref<string | null>(null);
let copiedTimer = 0;

const outParams = computed(() => store.status?.outParams ?? []);
const returnValue = computed(() => store.status?.returnValue ?? null);
const hasOutcome = computed(() => outParams.value.length > 0 || returnValue.value !== null);

interface OutcomeRow {
  key: string;
  name: string;
  mode: string;
  type: string;
  value: string | null;
  state?: string;
  resultRef?: PlDebugResultReference;
}

const rows = computed<OutcomeRow[]>(() => {
  const collected: OutcomeRow[] = outParams.value.map((param, index) => ({
    key: `param-${index}-${param.name}`,
    name: param.name,
    mode: param.mode,
    type: param.type,
    value: param.value,
    state: param.state,
    resultRef: param.resultRef,
  }));
  const returned = returnValue.value;
  if (returned) {
    collected.push({
      key: "return",
      name: t("plDebug.outcome.returnLabel"),
      // DBMS_DEBUG has no mode for a return value; the column stays readable.
      mode: "RETURN",
      type: returned.type ?? "",
      value: returned.value ?? null,
      state: returned.state,
      resultRef: returned.resultRef,
    });
  }
  return collected;
});

/** One row as a copyable line: `NAME MODE TYPE = value`. */
function rowText(row: OutcomeRow): string {
  const head = [row.name, row.mode, row.type].filter((part) => part !== "").join(" ");
  return `${head} = ${valueText(row)}`;
}

function valueText(row: OutcomeRow): string {
  if (row.state === "error") return t("plDebug.variables.readError");
  if (["pending", "unavailable", "unknown"].includes(row.state ?? "")) return t("plDebug.variables.unread");
  if (row.value === null) return "SQL NULL";
  return row.value === "" ? t("plDebug.variables.emptyString") : row.value;
}

async function copy(key: string, text: string) {
  if (!text) return;
  await copyToClipboard(text);
  copied.value = key;
  clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copied.value = null;
  }, 1500);
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 border-b px-2 py-1">
      <span class="text-xs font-medium">{{ t("plDebug.outcome.title") }}</span>
      <Button variant="ghost" size="sm" class="ml-auto h-6 w-6 p-0" :disabled="!hasOutcome || rows.some((row) => row.resultRef)" :title="t('plDebug.outcome.copyAll')" @click="copy('all', rows.map(rowText).join('\n'))">
        <Check v-if="copied === 'all'" class="h-3.5 w-3.5" />
        <Copy v-else class="h-3.5 w-3.5" />
      </Button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <table v-if="hasOutcome" class="w-full text-xs">
        <thead class="sticky top-0 bg-background">
          <tr class="text-left text-muted-foreground">
            <th class="px-2 py-1 font-normal">{{ t("plDebug.outcome.name") }}</th>
            <th class="w-20 px-2 py-1 font-normal">{{ t("plDebug.outcome.mode") }}</th>
            <th class="w-32 px-2 py-1 font-normal">{{ t("plDebug.outcome.type") }}</th>
            <th class="px-2 py-1 font-normal">{{ t("plDebug.outcome.value") }}</th>
            <th class="w-10 px-2 py-1 font-normal"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" class="border-t">
            <td class="px-2 py-1 align-top font-mono">{{ row.name }}</td>
            <td class="px-2 py-1 align-top">{{ row.mode }}</td>
            <td class="px-2 py-1 align-top font-mono text-muted-foreground">{{ row.type || "—" }}</td>
            <td class="whitespace-pre-wrap break-all px-2 py-1 align-top font-mono">
              <PlDebugResultValue v-if="row.resultRef && store.sessionRef && store.publicSnapshot" :result="row.resultRef" :session="store.sessionRef" :generation="store.publicSnapshot.generation" :name="row.name" />
              <span v-else>{{ valueText(row) }}</span>
            </td>
            <td class="px-2 py-1 align-top">
              <Button variant="ghost" size="sm" class="h-6 w-6 p-0" :disabled="!!row.resultRef" :title="t('plDebug.outcome.copy')" @click="copy(row.key, rowText(row))">
                <Check v-if="copied === row.key" class="h-3.5 w-3.5" />
                <Copy v-else class="h-3.5 w-3.5" />
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="px-2 py-3 text-center text-xs text-muted-foreground">{{ t("plDebug.outcome.empty") }}</p>
    </div>
  </div>
</template>
