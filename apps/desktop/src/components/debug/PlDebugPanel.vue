<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DebugToolbar from "@/components/debug/DebugToolbar.vue";
import DebugOutputPanel from "@/components/debug/DebugOutputPanel.vue";
import StackTracePanel from "@/components/debug/StackTracePanel.vue";
import VariablesPanel from "@/components/debug/VariablesPanel.vue";
import { usePlDebugStore } from "@/stores/plDebugStore";

const { t } = useI18n();
const store = usePlDebugStore();
const activeTab = ref<"variables" | "stack" | "output">("variables");

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
  if (store.hasSession) {
    store.refreshBreakpoints();
  }
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <DebugToolbar />
    <Tabs v-model:model-value="activeTab" class="flex min-h-0 flex-1 flex-col">
      <TabsList class="mx-2 mt-1 h-7">
        <TabsTrigger value="variables" class="text-xs">{{ t("plDebug.panel.variables") }}</TabsTrigger>
        <TabsTrigger value="stack" class="text-xs">{{ t("plDebug.panel.stack") }}</TabsTrigger>
        <TabsTrigger value="output" class="text-xs">{{ t("plDebug.panel.output") }}</TabsTrigger>
      </TabsList>
      <TabsContent value="variables" class="min-h-0 flex-1 overflow-hidden">
        <VariablesPanel />
      </TabsContent>
      <TabsContent value="stack" class="min-h-0 flex-1 overflow-hidden">
        <StackTracePanel />
      </TabsContent>
      <TabsContent value="output" class="min-h-0 flex-1 overflow-hidden">
        <DebugOutputPanel />
      </TabsContent>
    </Tabs>
  </div>
</template>
