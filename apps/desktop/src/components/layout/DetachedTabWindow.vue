<script setup lang="ts">
import { computed, ref, useAttrs } from "vue";
import { useI18n } from "vue-i18n";
import { X } from "@lucide/vue";
import EditorToolbar from "@/components/layout/EditorToolbar.vue";
import ContentArea from "@/components/layout/ContentArea.vue";
import { tabDisplayTitle } from "@/lib/tabs/tabPresentation";
import type { ConnectionConfig, QueryTab } from "@/types/database";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  activeTab?: QueryTab;
  activeConnection?: ConnectionConfig;
  executableSql: string;
  activeOutputView: "result" | "summary" | "explain" | "chart";
  formatSqlRequest: { id: number; tabId: string } | null;
  compressSqlRequest: { id: number; tabId: string } | null;
  selectedSql: string;
  cursorPos: number;
  blockDangerousRedisCommands: boolean;
  explainMode: "explain" | "autotrace";
  sqlKeywordCase: "preserve" | "upper" | "lower";
  autoCommit: boolean;
  txnSessionId?: string;
  txnAutoRolledBack?: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();
const { t } = useI18n();
const attrs = useAttrs();
const contentAreaRef = ref<InstanceType<typeof ContentArea> | null>(null);
const toolbarListeners = computed(() => Object.fromEntries(Object.entries(attrs).filter(([key]) => key.startsWith("on") && key !== "onExecute" && key !== "onExecuteInNewResultTab")));

defineExpose({
  focusSearch: () => contentAreaRef.value?.focusSearch(),
  refreshData: () => contentAreaRef.value?.refreshData(),
  refreshQueryEditorCompletionCache: () => contentAreaRef.value?.refreshQueryEditorCompletionCache(),
  handleModRTarget: (target: Element) => contentAreaRef.value?.handleModRTarget(target),
  requestQueryEditorExecute: () => contentAreaRef.value?.requestQueryEditorExecute(),
  requestQueryEditorExecuteInNewResultTab: () => contentAreaRef.value?.requestQueryEditorExecuteInNewResultTab(),
  pasteClipboardAsSqlInCondition: () => contentAreaRef.value?.pasteClipboardAsSqlInCondition(),
  applyTableStructureChanges: () => contentAreaRef.value?.applyTableStructureChanges(),
  insertRedisCommand: (command: string) => contentAreaRef.value?.insertRedisCommand(command),
  executeRedisCommand: (command: string) => contentAreaRef.value?.executeRedisCommand(command),
});
</script>

<template>
  <div class="fixed inset-0 flex h-screen w-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
    <header class="flex h-10 shrink-0 items-center gap-2 border-b bg-muted/50 px-3" data-tauri-drag-region>
      <span class="min-w-0 flex-1 truncate text-sm font-medium" data-tauri-drag-region>
        {{ activeTab ? tabDisplayTitle(activeTab, t) : t("contextMenu.openInNewWindow") }}
      </span>
      <button type="button" class="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" :aria-label="t('contextMenu.closeTab')" @click="emit('close')">
        <X class="h-4 w-4" />
      </button>
    </header>

    <div v-if="activeTab" class="flex min-h-0 flex-1 flex-col">
      <EditorToolbar
        v-if="activeTab.mode === 'query'"
        :active-tab="activeTab"
        :active-connection="activeConnection"
        :executable-sql="executableSql"
        :explain-mode="explainMode"
        :sql-keyword-case="sqlKeywordCase"
        :block-dangerous-redis-commands="blockDangerousRedisCommands"
        :auto-commit="autoCommit"
        :txn-session-id="txnSessionId"
        :txn-auto-rolled-back="txnAutoRolledBack"
        v-on="toolbarListeners"
        @execute="contentAreaRef?.requestQueryEditorExecute()"
      />
      <ContentArea
        ref="contentAreaRef"
        class="min-h-0 flex-1"
        :active-tab="activeTab"
        :active-connection="activeConnection"
        :executable-sql="executableSql"
        :active-output-view="activeOutputView"
        :format-sql-request="formatSqlRequest"
        :compress-sql-request="compressSqlRequest"
        :selected-sql="selectedSql"
        :cursor-pos="cursorPos"
        :block-dangerous-redis-commands="blockDangerousRedisCommands"
        v-on="$attrs"
      />
    </div>
    <div v-else class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {{ t("tabs.openTabUnavailable") }}
    </div>
  </div>
</template>
