<script setup lang="ts">
import { computed, ref, useAttrs } from "vue";
import ContentArea from "./ContentArea.vue";
import { createContentSurfaceEventForwarders } from "@/lib/tabs/contentSurfaceEvents";
import type { ContentAreaSurfaceEmits, ContentAreaSurfaceProps, QueryResultSurfaceHandle, StatementRange } from "./querySurfaces";

defineOptions({ inheritAttrs: false });

const props = defineProps<ContentAreaSurfaceProps>();
const emit = defineEmits<ContentAreaSurfaceEmits>();

const attrs = useAttrs();
const resultClass = computed(() => (typeof attrs.class === "string" ? attrs.class : undefined));
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

defineExpose<QueryResultSurfaceHandle>({
  focusSearch: () => contentAreaRef.value?.focusSearch() ?? false,
  refreshData: () => contentAreaRef.value?.refreshData() ?? false,
  toggleResultsPane: () => contentAreaRef.value?.toggleResultsPane() ?? false,
  handleModRTarget: (target: Element) => contentAreaRef.value?.handleModRTarget(target) ?? false,
  previewStatementRange: (range: StatementRange | null) => contentAreaRef.value?.previewStatementRange(range) ?? false,
  focusStatementRange: (range: StatementRange | null) => contentAreaRef.value?.focusStatementRange(range) ?? false,
});
</script>

<template>
  <div class="min-h-0 overflow-hidden" :class="resultClass">
    <ContentArea ref="contentAreaRef" v-bind="bindings" result-only class="h-full" />
  </div>
</template>
