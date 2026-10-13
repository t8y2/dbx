<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Pane, Splitpanes } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import BreakpointsPanel from "@/components/debug/BreakpointsPanel.vue";
import DebugLogPanel from "@/components/debug/DebugLogPanel.vue";
import DebuggeeSqlPanel from "@/components/debug/DebuggeeSqlPanel.vue";
import DebugTracePanel from "@/components/debug/DebugTracePanel.vue";
import DebugToolbar from "@/components/debug/DebugToolbar.vue";
import DebugOutputPanel from "@/components/debug/DebugOutputPanel.vue";
import PlDebugSourceEditor from "@/components/debug/PlDebugSourceEditor.vue";
import PlDebugOutcomePanel from "@/components/debug/PlDebugOutcomePanel.vue";
import StackTracePanel from "@/components/debug/StackTracePanel.vue";
import VariablesPanel from "@/components/debug/VariablesPanel.vue";
import { launchPlDebug, resolvePlDebugProbe } from "@/components/debug/plDebugLaunch";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { useConnectionStore } from "@/stores/connectionStore";
import { usePlDebugStore } from "@/stores/plDebugStore";
import { beginPanelResize, endPanelResize } from "@/lib/app/panelResizeState";

const { t } = useI18n();
const store = usePlDebugStore();
const connectionStore = useConnectionStore();
const activeTab = ref<"variables" | "stack" | "breakpoints" | "sql" | "trace" | "log" | "output" | "outcome">("variables");
const sourcePaneSize = ref(58);

/**
 * "Restart debugging" re-opens the launch dialog for the same routine: the old
 * session is given up only once the launch gate let the dialog through, and the
 * dialog re-reads the routine's parameters on open.
 *
 * The connection's database type is resolved here — the session target does not
 * keep it — because `launchPlDebug` refuses a target without one. Its absence made
 * the restart close the old session and then silently do nothing (an empty panel
 * with nothing to click), measured in the running app on 2026-10-13.
 *
 * An anonymous block has no database-side definition and no parameter dialog, so
 * restarting it resubmits the source the session was started from.
 */
async function restartDebugSession() {
  const target = store.target;
  const connectionId = store.connectionId;
  const database = store.database;
  if (!target || !connectionId || !database) return;
  const schema = target.schema ?? undefined;
  if (target.objectType.toUpperCase() === "ANONYMOUS") {
    const source = target.source ?? "";
    if (!source.trim()) return;
    const probe = await resolvePlDebugProbe(connectionId);
    if (probe.supported !== true) {
      store.pushHistory("WARN", `restart refused: ${probe.reason || "the server cannot be debugged"}`);
      return;
    }
    await store.close();
    try {
      await store.start(connectionId, database, { schema, objectType: "ANONYMOUS", source });
    } catch {
      // The store recorded the failure in `store.error`; the toolbar shows it.
    }
    return;
  }
  if (!target.objectName) return;
  const opened = await launchPlDebug({
    connectionId,
    database,
    databaseType: effectiveDatabaseTypeForConnection(connectionStore.getConfig(connectionId)),
    schema,
    objectType: target.objectType,
    objectName: target.objectName,
    packageName: target.packageName ?? undefined,
  });
  // A refused launch keeps the old session so the panel is never left empty.
  if (opened) await store.close();
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
//
// The watch source is edge-triggered (`stopSeq` bumps once per stop) and carries only
// primitives. A previous version watched the `status` object, which the refresh itself
// rewrites through `mergeStatusLocator` — every stop therefore re-armed its own watcher
// and hammered the agent with GET_VARIABLES/GET_STACK pairs until the next stop
// (measured in the running app 2026-10-13: 177 round-trip pairs a few seconds after one
// step; the churn is what made the debugger feel frozen).
//
// `busy` is part of the source because a stop lands while the continuation call that
// produced it is still in flight: the refresh must wait for that call to finish (its
// `finally` releases `busy`), which is also what makes a `resume` that stops at a
// breakpoint — with auto-resumed hits along the way — refresh exactly once, at the end.
//
// `immediate` covers the launch path: the debug tab mounts after `start` already parked
// the program, so without this first run the variables panel stayed empty until the user
// happened to step (reported from use, 2026-10-13).
watch(
  () => [store.stopSeq, store.busy, store.terminated] as const,
  async () => {
    if (store.busy) return;
    if (store.terminated) {
      // DBMS_OUTPUT is released exactly when the program finishes; the continue path
      // reads it too, this covers a panel mounted on an already-finished session.
      await store.refreshLog();
      return;
    }
    if (!store.hasSession) return;
    await Promise.allSettled([store.refreshVariables(), store.refreshStack()]);
    if (activeTab.value === "variables") {
      await store.refreshLog();
    }
  },
  { immediate: true },
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
            <TabsTrigger value="sql" class="text-xs">{{ t("plDebug.panel.sql") }}</TabsTrigger>
            <TabsTrigger value="trace" class="text-xs">{{ t("plDebug.panel.trace") }}</TabsTrigger>
            <TabsTrigger value="log" class="text-xs">{{ t("plDebug.panel.log") }}</TabsTrigger>
            <TabsTrigger value="output" class="text-xs">{{ t("plDebug.panel.output") }}</TabsTrigger>
            <TabsTrigger value="outcome" class="text-xs">{{ t("plDebug.outcome.title") }}</TabsTrigger>
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
          <TabsContent value="sql" class="min-h-0 flex-1 overflow-hidden">
            <DebuggeeSqlPanel />
          </TabsContent>
          <TabsContent value="trace" class="min-h-0 flex-1 overflow-hidden">
            <DebugTracePanel />
          </TabsContent>
          <TabsContent value="log" class="min-h-0 flex-1 overflow-hidden">
            <DebugLogPanel />
          </TabsContent>
          <TabsContent value="output" class="min-h-0 flex-1 overflow-hidden">
            <DebugOutputPanel />
          </TabsContent>
          <TabsContent value="outcome" class="min-h-0 flex-1 overflow-hidden">
            <PlDebugOutcomePanel />
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
