<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, RefreshCw, X } from "@lucide/vue";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import { POSTGRES_FOREIGN_SERVERS_SQL, type PostgresForeignTableDraft } from "@/lib/table/postgresForeignTable";

const draft = defineModel<PostgresForeignTableDraft>({ required: true });
const props = defineProps<{ connectionId: string; database: string; catalog?: string; disabled?: boolean }>();
const { t } = useI18n();
const servers = ref<string[]>([]);
const loading = ref(false);
const error = ref("");
let request = 0;

async function loadServers() {
  const current = ++request;
  loading.value = true;
  error.value = "";
  servers.value = [];
  try {
    const result = await api.executeQuery(props.connectionId, props.database, POSTGRES_FOREIGN_SERVERS_SQL, undefined, undefined, { catalog: props.catalog, maxRows: 10000 });
    if (current !== request) return;
    servers.value = result.rows.map((row) => String(row[0] ?? "")).filter(Boolean);
  } catch (reason) {
    if (current === request) error.value = translateBackendError(t, String(reason));
  } finally {
    if (current === request) loading.value = false;
  }
}

function setOption(index: number, key: "name" | "value", value: string) {
  draft.value = { ...draft.value, options: draft.value.options.map((option, position) => (position === index ? { ...option, [key]: value } : option)) };
}

watch(
  () => [props.connectionId, props.database, props.catalog],
  () => void loadServers(),
  { immediate: true },
);
onBeforeUnmount(() => {
  request += 1;
});
</script>

<template>
  <fieldset data-postgres-foreign-table-options class="max-h-64 shrink-0 space-y-2 overflow-y-auto rounded-md border p-3" :disabled="disabled">
    <div class="flex flex-wrap items-center gap-2">
      <label class="text-muted-foreground">{{ t("postgresForeignTable.server") }}</label>
      <SearchableSelect
        v-model="draft.server"
        :options="servers"
        :placeholder="t('postgresForeignTable.serverPlaceholder')"
        :search-placeholder="t('postgresForeignTable.serverPlaceholder')"
        :empty-text="t('postgresForeignTable.noServers')"
        :allow-custom="true"
        :loading="loading"
        :disabled="disabled"
        trigger-class="w-64 max-w-full"
      />
      <Button variant="ghost" size="icon-xs" :disabled="disabled || loading" :title="t('common.refresh')" @click="loadServers"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': loading }" /></Button>
    </div>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    <p v-else-if="!loading && !servers.length" class="text-xs text-muted-foreground">{{ t("postgresForeignTable.noServers") }}</p>
    <p class="text-xs text-muted-foreground">{{ t("postgresForeignTable.optionsHelp") }}</p>
    <div v-for="(option, index) in draft.options" :key="index" class="flex items-center gap-2" data-foreign-table-option>
      <Input :model-value="option.name" :aria-label="t('postgresForeignTable.optionName')" :placeholder="t('postgresForeignTable.optionName')" class="max-w-56 font-mono" :disabled="disabled" @update:model-value="setOption(index, 'name', String($event))" />
      <Input :model-value="option.value" :aria-label="t('postgresForeignTable.optionValue')" :placeholder="t('postgresForeignTable.optionValue')" class="max-w-md font-mono" :disabled="disabled" @update:model-value="setOption(index, 'value', String($event))" />
      <Button variant="ghost" size="icon-xs" :title="t('common.delete')" :disabled="disabled" @click="draft = { ...draft, options: draft.options.filter((_, position) => position !== index) }"><X class="h-4 w-4" /></Button>
    </div>
    <Button variant="outline" size="sm" :disabled="disabled" @click="draft = { ...draft, options: [...draft.options, { name: '', value: '' }] }"><Plus class="h-4 w-4" />{{ t("postgresForeignTable.addOption") }}</Button>
    <p class="text-xs text-muted-foreground">{{ t("postgresForeignTable.constraintsHelp") }}</p>
  </fieldset>
</template>
