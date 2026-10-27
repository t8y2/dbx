<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { QueryResult } from "@/types/database";
import { useToast } from "@/composables/useToast";
const { toast } = useToast();
async function copy(cell: unknown) {
  try {
    await navigator.clipboard.writeText(String(cell));
    toast(t("postgresAdmin.copied"), 1500);
  } catch (e) {
    toast(String(e), 3000);
  }
}
const props = defineProps<{ result: QueryResult | null }>();
const { t } = useI18n();
const search = ref("");
const sort = ref(-1);
const direction = ref(1);
const rows = computed(() => {
  const query = search.value.toLowerCase();
  const result = (props.result?.rows ?? []).filter(
    (row) =>
      !query ||
      row.some((cell) =>
        String(cell ?? "")
          .toLowerCase()
          .includes(query),
      ),
  );
  if (sort.value < 0) return result;
  return [...result].sort((a, b) => String(a[sort.value] ?? "").localeCompare(String(b[sort.value] ?? ""), undefined, { numeric: true }) * direction.value);
});
function sortBy(index: number) {
  direction.value = sort.value === index ? -direction.value : 1;
  sort.value = index;
}
</script>
<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
    <input v-model="search" class="h-7 w-48 max-w-full rounded border bg-background px-2 text-xs" :aria-label="t('postgresAdmin.filter')" :placeholder="t('postgresAdmin.filter')" />
    <p v-if="result?.truncated || result?.has_more" class="text-xs text-amber-600">{{ t("postgresAdmin.partial") }}</p>
    <div class="min-h-0 min-w-0 overflow-auto rounded border">
      <table class="w-full text-left text-xs">
        <thead class="sticky top-0 bg-muted">
          <tr>
            <th v-for="(column, index) in result?.columns" :key="index" class="whitespace-nowrap px-3 py-2">
              <button :aria-label="t('postgresAdmin.sort', { column })" @click="sortBy(index)">{{ column }} {{ sort === index ? (direction === 1 ? "↑" : "↓") : "" }}</button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in rows" :key="index" class="border-t hover:bg-accent/40">
            <td v-for="(cell, col) in row" :key="col" class="max-w-96 break-words px-3 py-2">
              <button class="select-text text-left" :disabled="cell === null" @click="cell !== null && copy(cell)">{{ cell ?? "—" }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!rows.length" class="p-4 text-xs text-muted-foreground">{{ t("postgresAdmin.noRows") }}</p>
    </div>
  </div>
</template>
