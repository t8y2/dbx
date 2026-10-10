<script setup lang="ts">
import { computed, inject, ref, shallowRef, watch, watchEffect } from "vue";
import QueryResultSurface from "./QueryResultSurface.vue";
import { useQueryStore } from "@/stores/queryStore";
import { createContentSurfaceEventForwarders } from "@/lib/tabs/contentSurfaceEvents";
import type { ContentAreaSurfaceEmits, ContentAreaSurfaceProps } from "./querySurfaces";
import type { QueryResult, QueryResultRun, QueryTab, TabOutputView } from "@/types/database";
import { INLINE_QUERY_RESULT_PORTAL, type InlineQueryResultPortal } from "@/lib/editor/inlineQueryResultPortal";

const props = defineProps<ContentAreaSurfaceProps & { result: QueryResult; resultIndex: number; run?: QueryResultRun }>();
const emit = defineEmits<ContentAreaSurfaceEmits>();
const store = useQueryStore();
const portal = inject<InlineQueryResultPortal>(INLINE_QUERY_RESULT_PORTAL);
const surface = ref<InstanceType<typeof QueryResultSurface> | null>(null);
const outputView = ref<TabOutputView>("result");
// The original result panel keeps these fields on the tab. Each inline panel
// retains its own copy, and restores it before invoking the original actions.
const stateKeys = [
  "resultSortColumn",
  "resultSortColumnIndex",
  "resultSortDirection",
  "resultSortMode",
  "resultSortedSql",
  "resultLocalSortOriginalRows",
  "resultLocalSortOriginalLargeValueCells",
  "resultLocalSortOriginalMongoDocuments",
  "resultLocalSortOriginalMongoCopyDocuments",
  "orderByInput",
  "structuredOrderByInput",
  "resultPageSql",
  "resultPageLimit",
  "resultPageOffset",
  "resultExecutedPageLimit",
  "resultExecutedPageOffset",
  "resultCountSql",
  "resultTotalRowCount",
  "resultTotalRowCountLoading",
  "resultPageJumpProgress",
  "queryAnalysis",
  "querySourceColumns",
  "queryWriteTargets",
  "queryDisplaySourceColumns",
  "queryEditabilityReason",
  "resultColumnComments",
  "mongoEditTarget",
  "tableMeta",
] as const satisfies readonly (keyof QueryTab)[];
function readState(tab: QueryTab): Partial<QueryTab> {
  return Object.fromEntries(stateKeys.map((key) => [key, tab[key]]));
}
const saved = shallowRef<Partial<QueryTab>>(portal?.states.get(props.result) ?? (props.run ? readState({ ...props.activeTab, ...props.run }) : Object.fromEntries(stateKeys.map((key) => [key, undefined]))));
function save(state: Partial<QueryTab>) {
  saved.value = state;
  portal?.states.set(props.result, state);
}
const isActive = computed(() => props.activeTab.result === props.result);
watch(
  () => props.activeOutputView,
  (view) => {
    if (isActive.value) outputView.value = view;
  },
);
watchEffect(
  () => {
    if (isActive.value && !props.activeTab.isExecuting) save(readState(props.activeTab));
  },
  { flush: "sync" },
);
watch(
  () => props.result,
  async (result) => {
    if (isActive.value) return;
    const metadata = await store.resolveResultMetadataForBatch(props.activeTab.id, result).catch(() => undefined);
    if (props.result === result && !isActive.value && metadata) save({ ...saved.value, ...metadata });
  },
  { immediate: true },
);
const displayedTab = computed<QueryTab>(() =>
  isActive.value
    ? props.activeTab
    : {
        ...props.activeTab,
        ...props.run,
        ...saved.value,
        id: props.activeTab.id,
        sql: props.activeTab.sql,
        result: props.result,
        results: props.run?.results ?? (props.run?.result ? [props.run.result] : props.activeTab.results),
        activeResultRunId: props.run?.id ?? props.activeTab.activeResultRunId,
        activeResultIndex: props.resultIndex,
        resultPageOffset: saved.value.resultPageOffset ?? 0,
      },
);
function activate() {
  if (isActive.value || props.activeTab.isExecuting) return;
  const state = saved.value;
  if (props.run && props.activeTab.activeResultRunId !== props.run.id) {
    // Inline-retained runs stay in memory: projection happens synchronously,
    // before the original grid's click/callback reads the active context.
    void store.setActiveResultRun(props.activeTab.id, props.run.id, { evictInactive: false });
  }
  store.setActiveResultIndex(props.activeTab.id, props.resultIndex);
  Object.assign(props.activeTab, state);
}
const forwarders = createContentSurfaceEventForwarders(emit);
const scopedForwarders = Object.fromEntries(
  Object.entries(forwarders).map(([name, handler]) => [
    name,
    (...args: unknown[]) => {
      activate();
      (handler as (...args: unknown[]) => void)(...args);
    },
  ]),
);
const bindings = computed(() => ({
  ...props,
  ...scopedForwarders,
  activateResult: activate,
  activeTab: displayedTab.value,
  activeOutputView: outputView.value,
  "onUpdate:activeOutputView": (_tabId: string, view: TabOutputView) => {
    outputView.value = view;
  },
}));
defineExpose({
  focusSearch: (target?: Element | null) => {
    activate();
    return surface.value?.focusSearch(target) ?? false;
  },
  refreshData: () => {
    activate();
    return surface.value?.refreshData() ?? false;
  },
  handleModRTarget: (target: Element) => {
    activate();
    return surface.value?.handleModRTarget(target) ?? false;
  },
});
</script>

<template>
  <div data-shared-result-surface :data-inline-result-index="resultIndex" :data-inline-result-key="`${run?.id ?? 'current'}:${resultIndex}`" class="h-full min-h-0 min-w-0 overflow-hidden" @pointerdown.capture="activate" @focusin.capture="activate" @keydown.capture="activate">
    <QueryResultSurface ref="surface" v-bind="bindings" inline-result class="h-full min-w-0" />
  </div>
</template>
