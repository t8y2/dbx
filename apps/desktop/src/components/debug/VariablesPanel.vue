<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Search } from "@lucide/vue";
import { Input } from "@/components/ui/input";
import { usePlDebugStore } from "@/stores/plDebugStore";

const { t } = useI18n();
const store = usePlDebugStore();
const filter = ref("");

const filteredVariables = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return store.variables;
  return store.variables.filter((entry) => entry.name.toLowerCase().includes(needle));
});
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="border-b px-2 py-1">
      <div class="relative">
        <Search class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="filter" class="h-7 pl-7 text-xs" :placeholder="t('plDebug.variables.filter')" />
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full text-xs">
        <thead class="sticky top-0 bg-background">
          <tr class="text-left text-muted-foreground">
            <th class="px-2 py-1 font-normal">{{ t("plDebug.variables.name") }}</th>
            <th class="px-2 py-1 font-normal">{{ t("plDebug.variables.value") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in filteredVariables" :key="entry.name" class="border-t">
            <td class="px-2 py-1 align-top font-mono">{{ entry.name }}</td>
            <td class="whitespace-pre-wrap break-all px-2 py-1 align-top font-mono">{{ entry.value }}</td>
          </tr>
          <tr v-if="filteredVariables.length === 0">
            <td colspan="2" class="px-2 py-3 text-center text-muted-foreground">
              {{ t("plDebug.variables.empty") }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
