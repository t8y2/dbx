<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { usePlDebugStore } from "@/stores/plDebugStore";

const { t } = useI18n();
const store = usePlDebugStore();

/** Newest entry first: the most recent debugger activity is the interesting one. */
const entries = computed(() => [...store.history].reverse());

const LEVEL_COLORS: Record<string, string> = {
  INFO: "#1890ff",
  WARN: "#faad14",
  ERROR: "#f5222d",
};

function levelColor(level: string): string {
  return LEVEL_COLORS[level] ?? LEVEL_COLORS.INFO;
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full text-xs">
        <thead class="sticky top-0 bg-background">
          <tr class="text-left text-muted-foreground">
            <th class="w-16 px-2 py-1 font-normal">{{ t("plDebug.log.status") }}</th>
            <th class="w-40 px-2 py-1 font-normal">{{ t("plDebug.log.time") }}</th>
            <th class="px-2 py-1 font-normal">{{ t("plDebug.log.message") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(entry, index) in entries" :key="`${entry.time}-${index}`" class="border-t">
            <td class="px-2 py-1 align-top font-medium" :style="{ color: levelColor(entry.level) }">{{ entry.level }}</td>
            <td class="px-2 py-1 align-top font-mono text-muted-foreground">{{ entry.time }}</td>
            <td class="whitespace-pre-wrap break-all px-2 py-1 align-top">{{ entry.message }}</td>
          </tr>
          <tr v-if="entries.length === 0">
            <td colspan="3" class="px-2 py-3 text-center text-muted-foreground">
              {{ t("plDebug.log.empty") }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
