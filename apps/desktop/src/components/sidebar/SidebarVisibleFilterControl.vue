<script setup lang="ts">
import { computed, inject } from "vue";
import { useI18n } from "vue-i18n";
import { ListFilter } from "@lucide/vue";
import { useConnectionStore } from "@/stores/connectionStore";
import type { TreeNode } from "@/types/database";
import { sidebarTreeRuntimeKey } from "@/lib/sidebar/sidebarTreeRuntime";
import { connectionCanConfigureSidebarVisibleDatabases } from "@/lib/sidebar/sidebarVisibleFilterMenu";

const props = defineProps<{
  node: TreeNode;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const sidebarTreeRuntime = inject(sidebarTreeRuntimeKey);
if (!sidebarTreeRuntime) throw new Error("SidebarVisibleFilterControl must be rendered inside ConnectionTree");
const treeRuntime = sidebarTreeRuntime;

const control = computed(() => {
  const connectionId = props.node.connectionId;
  if (props.node.type !== "connection" || !connectionId) return null;
  const config = connectionStore.getConfig(connectionId);
  if (!config || !connectionCanConfigureSidebarVisibleDatabases(config.db_type)) return null;
  const summary = connectionStore.getSidebarVisibleFilterSummary(connectionId);
  if (!summary) return null;
  const count = summary.selected == null || summary.total == null ? "" : ` (${summary.selected}/${summary.total})`;
  const labelKey = summary.mode === "schema" ? "visibleSchemas.sidebarControlLabel" : "visibleDatabases.sidebarControlLabel";
  return {
    ...summary,
    label: t(labelKey, { connection: config.name, count }),
  };
});

function openPrimaryVisibleFilter() {
  if (!control.value) return;
  treeRuntime.openPrimaryVisibleFilter(props.node);
}
</script>

<template>
  <button
    v-if="control"
    type="button"
    data-sidebar-visible-filter
    class="flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1 text-[10px] leading-none tabular-nums text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    :class="{ 'bg-primary/10 text-primary': control.isExplicit }"
    :aria-label="control.label"
    :title="control.label"
    @mousedown.stop
    @click.stop="openPrimaryVisibleFilter"
    @dblclick.stop
  >
    <span v-if="control.selected != null && control.total != null">{{ control.selected }}/{{ control.total }}</span>
    <ListFilter v-else class="h-3 w-3" aria-hidden="true" />
  </button>
</template>
