<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/backend/api";
import { copyToClipboard } from "@/lib/common/clipboard";
import { translateBackendError } from "@/i18n/backend-errors";
import type { ObjectInfo, ObjectSourceKind } from "@/types/database";

const props = defineProps<{ open: boolean; connectionId: string; database: string }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const { t } = useI18n();
const rows = ref<ObjectInfo[]>([]);
const category = ref("SEQUENCE");
const search = ref("");
const loading = ref(false);
const error = ref("");
const selected = ref<ObjectInfo | null>(null);
const detail = ref("");
const detailLoading = ref(false);
let loadEpoch = 0;
let detailEpoch = 0;
const categories = [
  ["SEQUENCE", "tree.firebirdGenerators"],
  ["PACKAGE", "tree.packages"],
  ["TRIGGER", "tree.triggers"],
  ["INDEX", "tree.indexes"],
  ["FUNCTION_INTERNAL", "tree.internalFunctions"],
  ["FUNCTION_UDF", "tree.udfFunctions"],
] as const;
const visible = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return rows.value.filter((row) => row.object_type === category.value && (!query || [row.name, row.comment, row.parent_name].some((value) => value?.toLocaleLowerCase().includes(query))));
});
function clearDetail() {
  detailEpoch++;
  selected.value = null;
  detail.value = "";
  detailLoading.value = false;
}
async function refresh() {
  const epoch = ++loadEpoch;
  loading.value = true;
  error.value = "";
  clearDetail();
  try {
    const objects = await api.listObjects(
      props.connectionId,
      props.database,
      "",
      categories.map(([type]) => type),
    );
    if (epoch === loadEpoch) rows.value = objects;
  } catch (cause) {
    if (epoch === loadEpoch) error.value = translateBackendError(t, cause);
  } finally {
    if (epoch === loadEpoch) loading.value = false;
  }
}
async function showDetail(row: ObjectInfo) {
  const epoch = ++detailEpoch;
  selected.value = row;
  detail.value = "";
  detailLoading.value = true;
  error.value = "";
  try {
    let text: string;
    if (row.object_type === "INDEX") {
      const literal = "'" + row.name.replaceAll("'", "''") + "'";
      const result = await api.executeQuery(
        props.connectionId,
        props.database,
        `SELECT TRIM(I.RDB$RELATION_NAME) AS TABLE_NAME, I.RDB$UNIQUE_FLAG AS UNIQUE_FLAG, I.RDB$INDEX_INACTIVE AS INACTIVE, I.RDB$INDEX_TYPE AS DESCENDING_FLAG, I.RDB$EXPRESSION_SOURCE AS EXPRESSION_SOURCE, TRIM(S.RDB$FIELD_NAME) AS FIELD_NAME, S.RDB$FIELD_POSITION AS FIELD_POSITION FROM RDB$INDICES I LEFT JOIN RDB$INDEX_SEGMENTS S ON S.RDB$INDEX_NAME=I.RDB$INDEX_NAME WHERE I.RDB$INDEX_NAME=${literal} ORDER BY S.RDB$FIELD_POSITION`,
      );
      text = result.rows.map((values) => result.columns.map((column, index) => `${column}: ${values[index] ?? "NULL"}`).join("\n")).join("\n\n");
    } else {
      const type: ObjectSourceKind = row.object_type.startsWith("FUNCTION_") ? "FUNCTION" : (row.object_type as ObjectSourceKind);
      const source = await api.getObjectSource(props.connectionId, props.database, "", row.name, type);
      text = source.source;
    }
    if (epoch === detailEpoch) detail.value = text || t("objects.empty");
  } catch (cause) {
    if (epoch === detailEpoch) error.value = translateBackendError(t, cause);
  } finally {
    if (epoch === detailEpoch) detailLoading.value = false;
  }
}
watch(category, clearDetail);
watch(
  () => [props.open, props.connectionId, props.database] as const,
  ([open]) => {
    if (open) void refresh();
    else {
      loadEpoch++;
      clearDetail();
      loading.value = false;
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="flex h-[80vh] max-w-6xl flex-col gap-3">
      <DialogHeader
        ><DialogTitle>{{ t("tree.firebirdObjectManager") }}</DialogTitle></DialogHeader
      >
      <div class="flex flex-wrap items-center gap-2">
        <select v-model="category" :aria-label="t('objects.type')" class="h-9 rounded border bg-background px-2 text-sm">
          <option v-for="[type, label] in categories" :key="type" :value="type">{{ t(label) }} ({{ rows.filter((row) => row.object_type === type).length }})</option>
        </select>
        <Input v-model="search" class="min-w-40 flex-1" :placeholder="t('objects.search')" />
        <Button variant="outline" :disabled="loading" @click="refresh">{{ t("grid.refresh") }}</Button>
      </div>
      <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
      <div v-if="loading" role="status">{{ t("common.loading") }}</div>
      <div v-else class="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <div class="min-w-0 flex-1 overflow-auto rounded border">
          <table class="w-full text-left text-sm">
            <thead class="sticky top-0 bg-muted">
              <tr>
                <th class="p-2">{{ t("objects.name") }}</th>
                <th class="p-2">{{ t("tree.tables") }} / {{ t("objects.comment") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in visible" :key="`${row.object_type}:${row.name}`" :class="selected === row ? 'bg-accent' : ''">
                <td class="p-2">
                  <button class="text-left hover:underline" @click="showDetail(row)">{{ row.name }}</button>
                </td>
                <td class="p-2 text-muted-foreground">{{ row.parent_name || row.comment }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!visible.length" class="p-4 text-sm text-muted-foreground">{{ t("objects.empty") }}</p>
        </div>
        <div v-if="selected" class="flex w-1/2 min-w-0 flex-col rounded border">
          <div class="flex items-center justify-between gap-2 border-b p-2">
            <span class="truncate">{{ selected.name }}</span
            ><Button variant="outline" :disabled="detailLoading || !detail" @click="copyToClipboard(detail)">{{ t("common.copy") }}</Button>
          </div>
          <p v-if="detailLoading" class="p-2">{{ t("common.loading") }}</p>
          <pre v-else class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 text-xs">{{ detail }}</pre>
        </div>
      </div>
      <p class="text-xs text-muted-foreground">{{ t("tree.firebirdReadOnlyHint") }}</p>
    </DialogContent>
  </Dialog>
</template>
