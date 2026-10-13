<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import MongoCompareEndpointSelect from "@/components/diff/MongoCompareEndpointSelect.vue";
import { compileMongoSql } from "@/lib/mongo/mongoSql";
import { mongoPipelineCode } from "@/lib/mongo/mongoAggregation";
import { useConnectionStore } from "@/stores/connectionStore";
import { saveTextFile } from "@/lib/export/saveTextFile";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";

const props = defineProps<{ prefillConnectionId?: string; prefillDatabase?: string; prefillCollection?: string }>();
const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const store = useConnectionStore();
const endpoint = ref({ connectionId: props.prefillConnectionId ?? "", database: props.prefillDatabase ?? "", collection: props.prefillCollection ?? "", filter: "{}" });
const sql = ref('SELECT * FROM "' + (props.prefillCollection || "collection").replaceAll('"', '""') + '" LIMIT 100');
const limit = ref(1000);
const loading = ref(false);
const error = ref("");
const results = shallowRef<unknown[]>([]);
const compiled = computed(() => {
  try {
    return { query: compileMongoSql(sql.value), error: "" };
  } catch (cause) {
    return { query: null, error: String(cause) };
  }
});
let executionId = "";
let generation = 0;
function cancel() {
  generation++;
  if (executionId) void api.cancelQuery(executionId).catch(() => {});
  loading.value = false;
}
onBeforeUnmount(cancel);
watch(open, (value) => {
  if (!value) cancel();
});
watch(
  [sql, endpoint, limit],
  () => {
    results.value = [];
    error.value = "";
  },
  { deep: true },
);
async function run() {
  if (!compiled.value.query || !endpoint.value.connectionId || !endpoint.value.database || loading.value) return;
  error.value = "";
  loading.value = true;
  results.value = [];
  const request = ++generation;
  const source = { ...endpoint.value };
  const query = compiled.value.query;
  executionId = uuid();
  try {
    if (!Number.isInteger(limit.value) || limit.value < 1 || limit.value > 10000) throw new Error(t("mongoAggregation.rowLimit"));
    await store.ensureConnected(source.connectionId);
    if (request !== generation) return;
    const response = await api.mongoAggregateDocuments(source.connectionId, source.database, query.collection, JSON.stringify(query.pipeline), limit.value, '{"maxTimeMS":60000}', executionId);
    if (request === generation) results.value = response.extended_documents ?? response.documents;
  } catch (cause) {
    if (request === generation) error.value = String(cause);
  } finally {
    if (request === generation) loading.value = false;
  }
}
async function exportQuery() {
  try {
    if (compiled.value.query) await saveTextFile(mongoPipelineCode("mongosh", endpoint.value.database, compiled.value.query.collection, compiled.value.query.pipeline), "mongo-sql-query.js", "JavaScript", "js");
  } catch (cause) {
    error.value = String(cause);
  }
}
</script>
<template>
  <Dialog v-model:open="open"
    ><DialogContent class="flex h-[min(850px,calc(100dvh-2rem))] max-w-[min(1300px,calc(100vw-2rem))] flex-col gap-0 p-0">
      <DialogHeader class="border-b border-border p-4"
        ><DialogTitle>{{ t("mongoSql.title") }}</DialogTitle>
        <p class="text-xs text-muted-foreground">{{ t("mongoSql.subtitle") }}</p></DialogHeader
      >
      <div class="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        <MongoCompareEndpointSelect v-model="endpoint" :disabled="loading" :label="t('mongoCompare.source')" database-only hide-filter />
        <p class="text-xs text-muted-foreground">{{ t("mongoSql.grammar") }}</p>
        <textarea v-model="sql" :disabled="loading" aria-label="SQL SELECT" spellcheck="false" class="min-h-36 w-full rounded border border-input bg-transparent p-3 font-mono text-sm focus-visible:outline-ring" />
        <p v-if="compiled.error || error" role="alert" class="text-xs text-destructive">{{ error || compiled.error }}</p>
        <div class="grid gap-3 lg:grid-cols-2">
          <div>
            <h3 class="font-semibold">{{ t("mongoAggregation.pipeline") }}</h3>
            <pre class="max-h-80 overflow-auto rounded border border-border p-2 text-xs">{{ JSON.stringify(compiled.query?.pipeline, null, 2) }}</pre>
          </div>
          <div>
            <h3 class="font-semibold">{{ t("mongoAggregation.preview") }}</h3>
            <pre class="max-h-80 overflow-auto rounded border border-border p-2 text-xs">{{ JSON.stringify(results, null, 2) }}</pre>
          </div>
        </div>
        <p class="text-xs">{{ t("mongoSql.semantics") }}</p>
      </div>
      <DialogFooter class="border-t border-border p-4"
        ><label class="flex items-center gap-2 text-xs">{{ t("mongoAggregation.maxRows") }}<Input v-model.number="limit" type="number" min="1" max="10000" :disabled="loading" class="w-24" /></label
        ><Button variant="outline" :disabled="!compiled.query" @click="exportQuery">{{ t("mongoAggregation.exportCode") }}</Button
        ><Button v-if="loading" variant="outline" @click="cancel">{{ t("common.cancel") }}</Button
        ><Button :disabled="loading || !compiled.query || !endpoint.database" @click="run">{{ t("mongoSql.run") }}</Button></DialogFooter
      >
    </DialogContent></Dialog
  >
</template>
