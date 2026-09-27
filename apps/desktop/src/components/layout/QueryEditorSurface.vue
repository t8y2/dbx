<script setup lang="ts">
import { computed, ref } from "vue";
import ContentArea from "./ContentArea.vue";
import { createContentSurfaceEventForwarders } from "@/lib/tabs/contentSurfaceEvents";
import type { ContentAreaSurfaceEmits, ContentAreaSurfaceProps, QueryEditorSurfaceHandle, StatementRange } from "./querySurfaces";
import type { AiConversationBinding } from "@/lib/ai/aiConversationBinding";

const props = defineProps<ContentAreaSurfaceProps & { autoFocus?: boolean }>();
const emit = defineEmits<ContentAreaSurfaceEmits>();
const surfaceProps = computed<ContentAreaSurfaceProps>(() => ({
  activeTab: props.activeTab,
  activeConnection: props.activeConnection,
  executableSql: props.executableSql,
  activeOutputView: props.activeOutputView,
  formatSqlRequest: props.formatSqlRequest,
  compressSqlRequest: props.compressSqlRequest,
  selectedSql: props.selectedSql,
  cursorPos: props.cursorPos,
  blockDangerousRedisCommands: props.blockDangerousRedisCommands,
}));
const contentEmits = createContentSurfaceEventForwarders(emit);
const bindings = computed(() => ({ ...surfaceProps.value, ...contentEmits }));
const contentAreaRef = ref<InstanceType<typeof ContentArea> | null>(null);

defineExpose<QueryEditorSurfaceHandle>({
  focusSearch: (target: Element | null = null) => contentAreaRef.value?.focusSearch(target) ?? false,
  openGoToColumn: () => contentAreaRef.value?.openGoToColumn() ?? false,
  refreshData: () => contentAreaRef.value?.refreshData() ?? false,
  toggleResultsPane: () => contentAreaRef.value?.toggleResultsPane() ?? false,
  refreshQueryEditorCompletionCache: () => contentAreaRef.value?.refreshQueryEditorCompletionCache() ?? false,
  handleModRTarget: (target: Element) => contentAreaRef.value?.handleModRTarget(target) ?? false,
  requestQueryEditorExecute: () => contentAreaRef.value?.requestQueryEditorExecute() ?? false,
  captureQueryEditorExecutionSnapshot: () => contentAreaRef.value?.captureQueryEditorExecutionSnapshot(),
  requestQueryEditorExecuteInNewResultTab: () => contentAreaRef.value?.requestQueryEditorExecuteInNewResultTab() ?? false,
  requestQueryEditorPreviewChanges: (stackSql?: string) => Promise.resolve(contentAreaRef.value?.requestQueryEditorPreviewChanges(stackSql) ?? false),
  shouldBlockQueryEditorExecutionShortcut: (event: KeyboardEvent) => contentAreaRef.value?.shouldBlockQueryEditorExecutionShortcut(event) ?? false,
  cancelQueryEditorExecutionViewport: (requestId: number) => contentAreaRef.value?.cancelQueryEditorExecutionViewport(requestId) ?? false,
  acceptQueryEditorExecutionViewport: (requestId: number) => contentAreaRef.value?.acceptQueryEditorExecutionViewport(requestId) ?? false,
  pasteClipboardAsSqlInCondition: () => contentAreaRef.value?.pasteClipboardAsSqlInCondition() ?? Promise.resolve(false),
  applyTableStructureChanges: () => contentAreaRef.value?.applyTableStructureChanges() ?? Promise.resolve(false),
  insertRedisCommand: (command: string, target: AiConversationBinding) => contentAreaRef.value?.insertRedisCommand(command, target) ?? Promise.resolve(false),
  executeRedisCommand: (command: string, target: AiConversationBinding) => contentAreaRef.value?.executeRedisCommand(command, target) ?? Promise.resolve(false),
  isRedisConsoleReady: (target: AiConversationBinding) => contentAreaRef.value?.isRedisConsoleReady(target) ?? false,
  previewStatementRange: (range: StatementRange | null) => contentAreaRef.value?.previewStatementRange(range) ?? false,
  focusStatementRange: (range: StatementRange | null) => contentAreaRef.value?.focusStatementRange(range) ?? false,
  focusErrorPosition: (offset: number) => contentAreaRef.value?.focusErrorPosition(offset) ?? false,
});
</script>

<template>
  <ContentArea ref="contentAreaRef" v-bind="bindings" editor-only :auto-focus="props.autoFocus" />
</template>
