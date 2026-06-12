<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, RefreshCw, Search } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import * as api from "@/lib/api";
import type { KafkaAclEntry } from "@/types/database";

const props = defineProps<{ connectionId: string }>();

const { t } = useI18n();
const loading = ref(false);
const acls = ref<KafkaAclEntry[]>([]);
const error = ref("");
const searchQuery = ref("");

const filteredAcls = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return acls.value;
  return acls.value.filter((entry) => [entry.resourceType, entry.resourceName, entry.patternType, entry.principal, entry.host, entry.operation, entry.permission].join(" ").toLowerCase().includes(query));
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    acls.value = await api.kafkaListAcls(props.connectionId);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    acls.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.connectionId,
  () => void load(),
);
onMounted(() => void load());
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <div class="min-w-0 flex-1 truncate text-sm font-medium">{{ t("kafka.aclsTitle") }}</div>
      <Badge variant="outline">{{ t("kafka.aclCount", { count: filteredAcls.length }) }}</Badge>
      <div class="relative w-56">
        <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="searchQuery" class="h-8 pl-8" :placeholder="t('kafka.aclSearchPlaceholder')" />
      </div>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loading" @click="load">
        <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        {{ t("grid.refresh") }}
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <div v-if="loading && acls.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {{ t("kafka.loadingAcls") }}
      </div>
      <div v-else-if="error" class="p-4 text-sm text-destructive">{{ error }}</div>
      <div v-else-if="filteredAcls.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">
        {{ searchQuery.trim() ? t("kafka.aclsNoMatch") : t("kafka.aclsEmpty") }}
      </div>
      <table v-else class="w-full border-collapse text-sm">
        <thead class="sticky top-0 z-10 bg-muted/80 backdrop-blur">
          <tr class="border-b text-left text-xs text-muted-foreground">
            <th class="px-3 py-2 font-medium">{{ t("kafka.aclResourceType") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.aclResourceName") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.aclPatternType") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.aclPrincipal") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.aclHost") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.aclOperation") }}</th>
            <th class="px-3 py-2 font-medium">{{ t("kafka.aclPermission") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(entry, index) in filteredAcls" :key="`${entry.principal}-${entry.resourceName}-${index}`" class="border-b border-border/50 hover:bg-accent/40">
            <td class="px-3 py-2 font-mono text-xs">{{ entry.resourceType }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ entry.resourceName || "*" }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ entry.patternType }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ entry.principal }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ entry.host || "*" }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ entry.operation }}</td>
            <td class="px-3 py-2 font-mono text-xs">{{ entry.permission }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
