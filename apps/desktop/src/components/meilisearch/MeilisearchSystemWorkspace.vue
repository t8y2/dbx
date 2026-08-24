<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Gauge, KeyRound, ListChecks } from "@lucide/vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import MeilisearchOverviewPage from "./MeilisearchOverviewPage.vue";
import MeilisearchKeysPage from "./MeilisearchKeysPage.vue";
import MeilisearchTasksPage from "./MeilisearchTasksPage.vue";

defineProps<{ connectionId: string }>();
type Section = "overview" | "keys" | "tasks";
const { t } = useI18n();
const active = ref<Section>("overview");
const sections = computed(() => [
  { value: "overview" as const, label: t("meilisearch.overview"), icon: Gauge },
  { value: "keys" as const, label: t("meilisearch.apiKeys"), icon: KeyRound },
  { value: "tasks" as const, label: t("meilisearch.tasks"), icon: ListChecks },
]);
</script>

<template>
  <Tabs v-model="active" class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-12 shrink-0 items-center border-b px-4">
      <div class="min-w-0 overflow-x-auto overflow-y-hidden">
        <TabsList class="h-8 w-max min-w-max justify-start bg-muted/60 p-0.5">
          <TabsTrigger v-for="section in sections" :key="section.value" :value="section.value" class="h-7 flex-none gap-1.5 px-3 text-xs"><component :is="section.icon" class="h-3.5 w-3.5" />{{ section.label }}</TabsTrigger>
        </TabsList>
      </div>
    </div>
    <TabsContent value="overview" class="m-0 min-h-0 flex-1 overflow-hidden"><MeilisearchOverviewPage :connection-id="connectionId" /></TabsContent>
    <TabsContent value="keys" class="m-0 min-h-0 flex-1 overflow-hidden"><MeilisearchKeysPage :connection-id="connectionId" /></TabsContent>
    <TabsContent value="tasks" class="m-0 min-h-0 flex-1 overflow-hidden"><MeilisearchTasksPage :connection-id="connectionId" /></TabsContent>
  </Tabs>
</template>
