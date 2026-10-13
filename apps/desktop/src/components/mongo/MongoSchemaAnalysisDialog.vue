<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Download, Play } from "@lucide/vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import MongoCompareEndpointSelect from "@/components/diff/MongoCompareEndpointSelect.vue";
import * as api from "@/lib/backend/api";
import { saveTextFile } from "@/lib/export/saveTextFile";
import { uuid } from "@/lib/common/utils";
import { analyzeMongoSchema, type MongoSchemaAnalysis } from "@/lib/mongo/mongoSchemaAnalysis";
import { readMongoCompareSnapshot, MongoCompareError } from "@/lib/mongo/mongoCompareRuntime";

const props = defineProps<{ prefillConnectionId?: string; prefillDatabase?: string; prefillCollection?: string }>();
const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const endpoint = ref({ connectionId: props.prefillConnectionId ?? "", database: props.prefillDatabase ?? "", collection: props.prefillCollection ?? "", filter: "{}" });
const limit = ref(1000);
const analysis = ref<MongoSchemaAnalysis | null>(null);
const loading = ref(false);
const error = ref("");
const search = ref("");
const rows = computed(() => (analysis.value?.fields ?? []).filter((field) => !search.value.trim() || field.path.toLowerCase().includes(search.value.toLowerCase())));
const page = ref(0);
const pageRows = computed(() => rows.value.slice(page.value * 200, (page.value + 1) * 200));
watch([analysis, search], () => {
  page.value = 0;
});
let controller: AbortController | undefined;
let executionId = "";
let generation = 0;
function cancel() {
  generation++;
  controller?.abort();
  if (executionId) void api.cancelQuery(executionId).catch(() => {});
  loading.value = false;
}
onBeforeUnmount(cancel);
watch(open, (visible) => {
  if (!visible) cancel();
});
watch(
  [endpoint, limit],
  () => {
    cancel();
    analysis.value = null;
    error.value = "";
  },
  { deep: true },
);
async function run() {
  if (!endpoint.value.connectionId || !endpoint.value.database || !endpoint.value.collection || loading.value) return;
  loading.value = true;
  error.value = "";
  analysis.value = null;
  const request = ++generation;
  controller = new AbortController();
  executionId = uuid();
  try {
    const snapshot = await readMongoCompareSnapshot(api, { ...endpoint.value }, { limit: limit.value, executionId, signal: controller.signal });
    if (request !== generation) return;
    analysis.value = analyzeMongoSchema(snapshot.documents, true, snapshot.documents.length, snapshot.truncated);
  } catch (cause) {
    if (request === generation) error.value = cause instanceof MongoCompareError ? t(`mongoCompare.errors.${cause.code}`) : String(cause);
  } finally {
    if (request === generation) loading.value = false;
  }
}
async function exportAnalysis() {
  try {
    if (analysis.value) await saveTextFile(JSON.stringify({ endpoint: endpoint.value, analysis: analysis.value }, null, 2), "mongo-schema-analysis.json", "JSON", "json");
  } catch (cause) {
    error.value = String(cause);
  }
}
</script>

<template>
  <Dialog v-model:open="open"
    ><DialogContent class="flex h-[min(850px,calc(100dvh-2rem))] max-w-[min(1200px,calc(100vw-2rem))] flex-col gap-0 p-0"
      ><DialogHeader class="border-b border-border px-5 py-4"
        ><DialogTitle>{{ t("mongoSchema.title") }}</DialogTitle>
        <p class="text-xs text-muted-foreground">{{ t("mongoSchema.subtitle") }}</p></DialogHeader
      >
      <div class="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        <MongoCompareEndpointSelect v-model="endpoint" :disabled="loading" :label="t('mongoSchema.collection')" />
        <div class="flex flex-wrap items-end gap-2">
          <label class="text-xs">{{ t("mongoSchema.limit") }}<Input v-model.number="limit" :disabled="loading" type="number" min="1" max="100000" class="h-8 w-32 text-xs" /></label><label class="text-xs">{{ t("mongoSchema.search") }}<Input v-model="search" class="h-8 w-48 text-xs" /></label
          ><Button :disabled="loading" @click="run"><Play class="size-3" />{{ t("mongoSchema.analyze") }}</Button
          ><Button variant="ghost" :disabled="!analysis" @click="exportAnalysis"><Download class="size-3" />{{ t("mongoSchema.export") }}</Button>
        </div>
        <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
        <p class="text-xs">{{ t("mongoSchema.sampleHint") }}</p>
        <p v-if="analysis?.truncated" role="status" class="text-xs">{{ t("mongoSchema.truncated") }}</p>
        <p v-if="analysis" class="text-xs">
          {{ t("mongoSchema.summary", { documents: analysis.documentCount, fields: analysis.fields.length }) }}<span v-if="analysis.depthLimited || analysis.fieldLimited"> · {{ t("mongoSchema.limited") }}</span>
        </p>
        <div class="overflow-auto rounded-md border border-border">
          <table class="w-full text-xs">
            <thead class="sticky top-0 bg-muted">
              <tr>
                <th class="p-2 text-left">{{ t("mongoSchema.path") }}</th>
                <th class="p-2 text-right">{{ t("mongoSchema.documents") }}</th>
                <th class="p-2 text-right">{{ t("mongoSchema.occurrences") }}</th>
                <th class="p-2 text-left">{{ t("mongoSchema.types") }}</th>
                <th class="p-2 text-left">{{ t("mongoSchema.examples") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="field in pageRows" :key="field.path" class="border-t border-border">
                <td class="p-2 font-mono">{{ field.path }}</td>
                <td class="p-2 text-right">{{ field.documents }} / {{ field.missing }}</td>
                <td class="p-2 text-right">{{ field.occurrences }}</td>
                <td class="p-2">
                  {{
                    Object.entries(field.types)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(", ")
                  }}
                </td>
                <td class="max-w-80 break-all p-2">{{ field.examples.join(" · ") }}</td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="5" class="p-6 text-center text-muted-foreground">{{ t("mongoSchema.empty") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="rows.length > 200" class="flex items-center gap-2">
          <Button variant="outline" :disabled="page === 0" :aria-label="t('mongoTransform.previous')" @click="page--">←</Button><span class="text-xs">{{ page + 1 }} / {{ Math.ceil(rows.length / 200) }}</span
          ><Button variant="outline" :disabled="(page + 1) * 200 >= rows.length" :aria-label="t('mongoTransform.next')" @click="page++">→</Button>
        </div>
      </div>
      <DialogFooter class="border-t border-border px-4 py-3"
        ><Button v-if="loading" variant="outline" @click="cancel">{{ t("common.cancel") }}</Button
        ><Button variant="outline" @click="open = false">{{ t("common.close") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
</template>
