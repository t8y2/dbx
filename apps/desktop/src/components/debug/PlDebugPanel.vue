<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Pane, Splitpanes } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import BreakpointsPanel from "@/components/debug/BreakpointsPanel.vue";
import DebugLogPanel from "@/components/debug/DebugLogPanel.vue";
import DebugToolbar from "@/components/debug/DebugToolbar.vue";
import DebugOutputPanel from "@/components/debug/DebugOutputPanel.vue";
import PlDebugSourceEditor from "@/components/debug/PlDebugSourceEditor.vue";
import StackTracePanel from "@/components/debug/StackTracePanel.vue";
import VariablesPanel from "@/components/debug/VariablesPanel.vue";
import { launchPlDebug } from "@/components/debug/plDebugLaunch";
import { usePlDebugStore } from "@/stores/plDebugStore";
import { beginPanelResize, endPanelResize } from "@/lib/app/panelResizeState";

const { t } = useI18n();
const store = usePlDebugStore();
const activeTab = ref<"variables" | "stack" | "breakpoints" | "log" | "output">("variables");
const sourcePaneSize = ref(58);

/**
 * "Restart debugging" re-opens the launch dialog for the same routine: the old
 * session is closed first, and the dialog re-reads the routine's parameters.
 */
async function restartDebugSession() {
  const target = store.target;
  const connectionId = store.connectionId;
  const database = store.database;
  if (!target?.objectName || !connectionId || !database) return;
  const launchTarget = {
    connectionId,
    database,
    schema: target.schema ?? undefined,
    objectType: target.objectType,
    objectName: target.objectName,
    packageName: target.packageName ?? undefined,
  };
  await store.close();
  // Re-launching goes through the same gate; the probe is cached per
  // connection, so "Restart debugging" does not re-probe the server.
  await launchPlDebug(launchTarget);
}

function onSourceSplitResize() {
  beginPanelResize();
}

function onSourcePaneResized(payload: { panes: { size: number }[] }) {
  endPanelResize();
  const sourcePane = payload.panes[0];
  if (sourcePane?.size != null && sourcePane.size >= 15 && sourcePane.size <= 85) {
    sourcePaneSize.value = sourcePane.size;
  }
}

// Refresh the panels whenever the debuggee parks on a new stop.
watch(
  () => [store.status, store.terminated] as const,
  async ([, wasTerminated]) => {
    if (store.terminated && !wasTerminated) {
      await store.refreshLog();
      return;
    }
    if (!store.busy && store.hasSession) {
      await Promise.allSettled([store.refreshVariables(), store.refreshStack()]);
      if (activeTab.value === "variables") {
        await store.refreshLog();
      }
    }
  },
);

onMounted(() => {
  // Restores the dots after the tab is reopened; a no-op without a live session.
  store.refreshBreakpoints();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <DebugToolbar @restart="restartDebugSession" />
    <Splitpanes horizontal class="pl-debug-splitpanes min-h-0 flex-1" @resize="onSourceSplitResize" @resized="onSourcePaneResized">
      <Pane v-if="store.target" class="min-h-0" :size="sourcePaneSize" :min-size="15">
        <PlDebugSourceEditor class="h-full" />
      </Pane>
      <Pane class="min-h-0" :size="store.target ? 100 - sourcePaneSize : 100" :min-size="store.target ? 20 : 100">
        <Tabs v-model:model-value="activeTab" class="flex h-full min-h-0 flex-col">
          <TabsList class="mx-2 mt-1 h-7">
            <TabsTrigger value="variables" class="text-xs">{{ t("plDebug.panel.variables") }}</TabsTrigger>
            <TabsTrigger value="stack" class="text-xs">{{ t("plDebug.panel.stack") }}</TabsTrigger>
            <TabsTrigger value="breakpoints" class="text-xs">{{ t("plDebug.panel.breakpoints") }}</TabsTrigger>
            <TabsTrigger value="log" class="text-xs">{{ t("plDebug.panel.log") }}</TabsTrigger>
            <TabsTrigger value="output" class="text-xs">{{ t("plDebug.panel.output") }}</TabsTrigger>
          </TabsList>
          <TabsContent value="variables" class="min-h-0 flex-1 overflow-hidden">
            <VariablesPanel />
          </TabsContent>
          <TabsContent value="stack" class="min-h-0 flex-1 overflow-hidden">
            <StackTracePanel />
          </TabsContent>
          <TabsContent value="breakpoints" class="min-h-0 flex-1 overflow-hidden">
            <BreakpointsPanel />
          </TabsContent>
          <TabsContent value="log" class="min-h-0 flex-1 overflow-hidden">
            <DebugLogPanel />
          </TabsContent>
          <TabsContent value="output" class="min-h-0 flex-1 overflow-hidden">
            <DebugOutputPanel />
          </TabsContent>
        </Tabs>
      </Pane>
    </Splitpanes>
  </div>
</template>

<style scoped>
.pl-debug-splitpanes {
  isolation: isolate;
}

.pl-debug-splitpanes :deep(> .splitpanes__splitter) {
  z-index: 1;
  flex: 0 0 3px;
}
</style>
