<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Play } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePlDebugStore } from "@/stores/plDebugStore";

/**
 * 调试会话内的 SQL 控制台（PL/SQL Developer 的「调试会话里执行」）。
 *
 * 语句在 **debuggee 会话**里执行（agent 走 `DBMS_DEBUG.EXECUTE`），所以它能看到该
 * 会话未提交的行与包状态 —— 这一点是普通查询连接做不到的。程序没有停靠时服务器会
 * 拒绝，拒绝理由原样显示在这里，不吞掉。
 */
const { t } = useI18n();
const store = usePlDebugStore();
const statement = ref("");
const rows = ref<string[]>([]);
const errorText = ref<string | null>(null);

const canRun = computed(() => store.hasSession && store.terminated !== true && statement.value.trim() !== "" && store.busy !== true);

async function run() {
  if (!canRun.value) return;
  errorText.value = null;
  try {
    const result = await store.executeInDebuggee(statement.value);
    rows.value = result.rows ?? [];
    if (result.ok === false) errorText.value = result.error ?? t("plDebug.sql.rejected");
  } catch (caught) {
    rows.value = [];
    errorText.value = String(caught);
  }
}
</script>

<template>
  <div class="flex h-full flex-col gap-1 p-2">
    <p class="text-[11px] text-muted-foreground">{{ t("plDebug.sql.hint") }}</p>
    <div class="flex items-center gap-1">
      <Input v-model="statement" class="h-6 flex-1 font-mono text-xs" :placeholder="t('plDebug.sql.placeholder')" :disabled="!store.hasSession || store.terminated" @keyup.enter="run" />
      <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs" :disabled="!canRun" :title="t('plDebug.sql.run')" @click="run">
        <Play class="h-3.5 w-3.5" />
        {{ t("plDebug.sql.run") }}
      </Button>
    </div>
    <p v-if="errorText" class="whitespace-pre-wrap break-all text-[11px] text-destructive">{{ t("plDebug.sql.failed", { error: errorText }) }}</p>
    <div class="min-h-0 flex-1 overflow-auto">
      <table v-if="rows.length > 0" class="w-full text-xs">
        <tbody>
          <tr v-for="(row, index) in rows" :key="index" class="border-t">
            <td class="w-10 px-2 py-1 align-top font-mono text-muted-foreground">{{ index + 1 }}</td>
            <td class="whitespace-pre-wrap break-all px-2 py-1 align-top font-mono">{{ row }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="!errorText" class="px-2 py-3 text-center text-xs text-muted-foreground">{{ t("plDebug.sql.empty") }}</p>
    </div>
  </div>
</template>
