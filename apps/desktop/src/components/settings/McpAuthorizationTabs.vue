<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type SectionId = "overrides" | "connections" | "databases" | "capabilities";

const { t } = useI18n();

const sections = computed<Array<{ id: SectionId; title: string }>>(() => [
  { id: "overrides", title: t("settings.mcpAuthTabOverridesTitle") },
  { id: "connections", title: t("settings.mcpAuthTabConnectionsTitle") },
  { id: "databases", title: t("settings.mcpAuthTabDatabasesTitle") },
  { id: "capabilities", title: t("settings.mcpAuthTabCapabilitiesTitle") },
]);

const currentSection = defineModel<SectionId>({ default: "overrides" });
</script>

<template>
  <section class="space-y-3">
    <header class="space-y-1">
      <p class="text-sm font-semibold">{{ t("settings.mcpAuthTitle") }}</p>
      <p class="text-xs text-muted-foreground">{{ t("settings.mcpAuthDescription") }}</p>
    </header>

    <!-- The sections are independent views over one staged policy draft (persisted by the settings
         footer Apply button), not sequential steps, so every one is a directly reachable tab. Hidden
         panels stay mounted (unmount-on-hide=false) so the pickers keep their search/expand state across tab switches. -->
    <Tabs v-model="currentSection" :unmount-on-hide="false" class="gap-4">
      <TabsList variant="line" class="h-9 w-full justify-start gap-1 overflow-x-auto border-b border-border/60 bg-transparent p-0" :aria-label="t('settings.mcpAuthTitle')">
        <TabsTrigger v-for="section in sections" :key="section.id" :value="section.id" class="flex-none px-3">{{ section.title }}</TabsTrigger>
      </TabsList>
      <TabsContent v-for="section in sections" :key="section.id" :value="section.id" :data-settings-search-id="`mcp-${section.id}`" class="m-0">
        <slot :name="section.id" />
      </TabsContent>
    </Tabs>
  </section>
</template>
