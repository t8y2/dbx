<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Download, Play, Plus, Trash2 } from "@lucide/vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import MongoCompareEndpointSelect from "@/components/diff/MongoCompareEndpointSelect.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import * as api from "@/lib/backend/api";
import { saveTextFile } from "@/lib/export/saveTextFile";
import { uuid } from "@/lib/common/utils";
import { buildMongoPipeline, MONGO_STAGE_TEMPLATES, mongoPipelineCode, mongoPipelineOutput, mongoPipelinePreview, parseMongoPipeline, type MongoCodeLanguage, type MongoPipelineStage } from "@/lib/mongo/mongoAggregation";

const props = defineProps<{ prefillConnectionId?: string; prefillDatabase?: string; prefillCollection?: string }>();
const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const store = useConnectionStore();
const endpoint = ref({ connectionId: props.prefillConnectionId ?? "", database: props.prefillDatabase ?? "", collection: props.prefillCollection ?? "", filter: "{}" });
const stages = ref<MongoPipelineStage[]>([{ id: uuid(), operator: "$match", body: "{}", enabled: true }]);
const maxRows = ref(100);
const results = shallowRef<unknown[]>([]);
const language = ref<MongoCodeLanguage>("mongosh");
const error = ref("");
const notice = ref("");
const loading = ref(false);
const writing = ref(false);
const metadataLoading = ref(false);
const fileInput = ref<HTMLInputElement>();
type Review = { endpoint: typeof endpoint.value; targetDatabase: string; text: string };
const review = shallowRef<Review | null>(null);
const locked = computed(() => loading.value || writing.value || !!review.value);
const ready = computed(() => !!endpoint.value.connectionId && !!endpoint.value.database && !!endpoint.value.collection && !metadataLoading.value && !locked.value);
const parsed = computed(() => {
  try {
    return { pipeline: buildMongoPipeline(stages.value), error: "" };
  } catch (cause) {
    return { pipeline: null, error: describe(cause) };
  }
});
const code = computed(() => (parsed.value.pipeline ? mongoPipelineCode(language.value, endpoint.value.database, endpoint.value.collection, parsed.value.pipeline) : ""));
let generation = 0;
let executionId = "";
function describe(cause: unknown) {
  if (cause instanceof Error && cause.message === "outputTarget") return t("mongoAggregation.outputTarget");
  return cause instanceof Error ? cause.message : String(cause);
}
function cancel() {
  generation++;
  if (executionId && !writing.value) void api.cancelQuery(executionId).catch(() => {});
  loading.value = false;
  review.value = null;
}
onBeforeUnmount(cancel);
watch(open, (visible) => {
  if (!visible) cancel();
});
watch(
  [stages, endpoint, maxRows],
  () => {
    results.value = [];
    notice.value = "";
    review.value = null;
  },
  { deep: true },
);
function addStage() {
  stages.value.push({ id: uuid(), operator: "$match", body: "{}", enabled: true });
}
function moveStage(index: number, delta: number) {
  const next = index + delta;
  if (next < 0 || next >= stages.value.length) return;
  [stages.value[index], stages.value[next]] = [stages.value[next]!, stages.value[index]!];
}
function changeOperator(index: number, value: unknown) {
  const operator = String(value);
  stages.value[index] = { ...stages.value[index]!, operator, body: JSON.stringify(MONGO_STAGE_TEMPLATES[operator] ?? {}, null, 2) };
}
async function importPipeline(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  try {
    if (!file || locked.value) return;
    if (file.size > 2 * 1024 * 1024) throw new Error(t("mongoAggregation.importLimit"));
    const pipeline = parseMongoPipeline(await file.text());
    if (locked.value || !open.value) return;
    stages.value = pipeline.map((stage) => ({ id: uuid(), operator: Object.keys(stage)[0], body: JSON.stringify(Object.values(stage)[0], null, 2), enabled: true }));
    error.value = "";
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    if (fileInput.value) fileInput.value.value = "";
  }
}
async function exportText(kind: "pipeline" | "code") {
  try {
    const text = kind === "code" ? code.value : JSON.stringify(buildMongoPipeline(stages.value), null, 2);
    if (!text) return;
    await saveTextFile(text, kind === "code" ? `mongo-aggregation.${language.value}.txt` : "mongo-pipeline.json", kind === "code" ? "Code" : "JSON", kind === "code" ? "txt" : "json");
  } catch (cause) {
    error.value = describe(cause);
  }
}
async function run(through = stages.value.length - 1, prepareWrite = false) {
  if (!ready.value) return;
  error.value = "";
  notice.value = "";
  review.value = null;
  const request = ++generation;
  const source = { ...endpoint.value };
  try {
    if (!Number.isInteger(maxRows.value) || maxRows.value < 1 || maxRows.value > 10000) throw new Error(t("mongoAggregation.rowLimit"));
    const pipeline = buildMongoPipeline(stages.value, through);
    const target = mongoPipelineOutput(pipeline, source.database);
    if (prepareWrite && target && connectionIsEffectivelyReadOnly(store.getConfig(source.connectionId))) throw new Error(t("mongoAggregation.outputReadOnly"));
    loading.value = true;
    executionId = uuid();
    await store.ensureConnected(source.connectionId);
    if (request !== generation) return;
    const value = await api.mongoAggregateDocuments(source.connectionId, source.database, source.collection, JSON.stringify(mongoPipelinePreview(pipeline, source.database)), maxRows.value, '{"maxTimeMS":60000}', executionId);
    if (request !== generation) return;
    results.value = value.extended_documents ?? value.documents;
    notice.value = t("mongoAggregation.previewLimit", { count: results.value.length, limit: maxRows.value });
    if (prepareWrite && target) review.value = { endpoint: source, targetDatabase: target.database, text: JSON.stringify({ aggregate: source.collection, pipeline, cursor: {}, maxTimeMS: 60000 }, null, 2) };
  } catch (cause) {
    if (request === generation) error.value = describe(cause);
  } finally {
    if (request === generation) loading.value = false;
  }
}
async function apply() {
  const plan = review.value;
  if (!plan || writing.value) return;
  writing.value = true;
  error.value = "";
  const request = generation;
  try {
    if (connectionIsEffectivelyReadOnly(store.getConfig(plan.endpoint.connectionId))) throw new Error(t("mongoAggregation.outputReadOnly"));
    const execute = async () => {
      if (request !== generation || !open.value) return false;
      if (connectionIsEffectivelyReadOnly(store.getConfig(plan.endpoint.connectionId))) throw new Error(t("mongoAggregation.outputReadOnly"));
      executionId = uuid();
      const response = await api.mongoRunCommand(plan.endpoint.connectionId, plan.endpoint.database, plan.text, executionId);
      const result = response.documents[0] as Record<string, unknown> | undefined;
      if (!result || result.ok !== 1 || (Array.isArray(result.writeErrors) && result.writeErrors.length) || result.writeConcernError) throw new Error(JSON.stringify(result ?? "Missing write response"));
      return true;
    };
    const guard = (database: string, action: () => Promise<boolean | undefined>) =>
      executeWithProductionContextGuard({
        connection: store.getConfig(plan.endpoint.connectionId),
        database,
        reviewText: plan.text,
        source: t("mongoAggregation.title"),
        execute: action,
      });
    const done = await guard(plan.endpoint.database, () => (plan.targetDatabase === plan.endpoint.database ? execute() : guard(plan.targetDatabase, execute)));
    if (done) notice.value = t("mongoAggregation.applied");
  } catch (cause) {
    error.value = describe(cause);
    notice.value = t("mongoAggregation.writeUncertain");
  } finally {
    writing.value = false;
    review.value = null;
  }
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!writing) open = value;
      }
    "
  >
    <DialogContent :show-close-button="!writing" class="flex h-[min(900px,calc(100dvh-2rem))] max-w-[min(1400px,calc(100vw-2rem))] flex-col gap-0 p-0" @escape-key-down="(e) => writing && e.preventDefault()" @interact-outside.prevent>
      <DialogHeader class="border-b border-border px-5 py-4">
        <DialogTitle>{{ t("mongoAggregation.title") }}</DialogTitle>
        <p class="text-xs text-muted-foreground">{{ t("mongoAggregation.subtitle") }}</p>
      </DialogHeader>
      <div class="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        <MongoCompareEndpointSelect v-model="endpoint" :label="t('mongoAggregation.collection')" :disabled="locked" hide-filter @loading="metadataLoading = $event" />
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" :disabled="locked" @click="addStage"><Plus class="size-3" />{{ t("mongoAggregation.addStage") }}</Button>
          <Button size="sm" variant="outline" :disabled="locked" @click="fileInput?.click()">{{ t("mongoAggregation.import") }}</Button>
          <input ref="fileInput" type="file" accept=".json,application/json" class="hidden" @change="importPipeline" />
          <Button size="sm" variant="outline" :disabled="!parsed.pipeline" @click="exportText('pipeline')">{{ t("mongoAggregation.export") }}</Button>
          <label class="flex items-center gap-2 text-xs">{{ t("mongoAggregation.maxRows") }}<Input v-model.number="maxRows" type="number" min="1" max="10000" class="h-8 w-24" :disabled="locked" /></label>
        </div>
        <fieldset :disabled="locked" class="space-y-2">
          <legend class="sr-only">{{ t("mongoAggregation.pipeline") }}</legend>
          <div v-for="(stage, index) in stages" :key="stage.id" class="rounded-md border border-border p-2">
            <div class="flex flex-wrap items-center gap-2">
              <input v-model="stage.enabled" type="checkbox" :aria-label="t('mongoAggregation.enableStage', { index: index + 1 })" />
              <span class="text-xs">{{ index + 1 }}</span>
              <Select :model-value="stage.operator" :disabled="locked" @update:model-value="(v) => changeOperator(index, v)">
                <SelectTrigger class="h-8 w-36 text-xs" :aria-label="t('mongoAggregation.operator')"><SelectValue /></SelectTrigger>
                <SelectContent
                  ><SelectItem v-for="operator in [...new Set([...Object.keys(MONGO_STAGE_TEMPLATES), stage.operator])]" :key="operator" :value="operator">{{ operator }}</SelectItem></SelectContent
                >
              </Select>
              <Button size="sm" variant="ghost" :disabled="locked || index === 0" :aria-label="t('mongoAggregation.moveUp')" @click="moveStage(index, -1)">↑</Button>
              <Button size="sm" variant="ghost" :disabled="locked || index === stages.length - 1" :aria-label="t('mongoAggregation.moveDown')" @click="moveStage(index, 1)">↓</Button>
              <Button size="sm" variant="ghost" :disabled="locked" :aria-label="t('mongoAggregation.deleteStage')" @click="stages.splice(index, 1)"><Trash2 class="size-3" /></Button>
              <Button size="sm" variant="outline" :disabled="!ready" @click="run(index)">{{ t("mongoAggregation.previewStage") }}</Button>
            </div>
            <textarea v-model="stage.body" :aria-label="t('mongoAggregation.stageBody', { index: index + 1 })" class="mt-2 min-h-24 w-full rounded border border-input bg-transparent p-2 font-mono text-xs focus-visible:outline-ring" spellcheck="false" />
          </div>
        </fieldset>
        <p v-if="parsed.error" role="alert" class="text-xs text-destructive">{{ parsed.error }}</p>
        <div class="grid gap-3 lg:grid-cols-2">
          <div>
            <h3 class="text-xs font-semibold">{{ t("mongoAggregation.preview") }}</h3>
            <pre class="mt-1 max-h-64 overflow-auto rounded border border-border p-2 text-xs">{{ JSON.stringify(results, null, 2) }}</pre>
          </div>
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="text-xs font-semibold">{{ t("mongoAggregation.code") }}</h3>
              <Select v-model="language"
                ><SelectTrigger class="h-8 w-32 text-xs" :aria-label="t('mongoAggregation.language')"><SelectValue /></SelectTrigger
                ><SelectContent
                  ><SelectItem v-for="name in ['mongosh', 'node', 'python', 'java', 'csharp']" :key="name" :value="name">{{ name }}</SelectItem></SelectContent
                ></Select
              >
              <Button size="sm" variant="ghost" :disabled="!code" @click="exportText('code')"><Download class="size-3" />{{ t("mongoAggregation.exportCode") }}</Button>
            </div>
            <pre class="mt-1 max-h-64 overflow-auto rounded border border-border p-2 text-xs">{{ code }}</pre>
          </div>
        </div>
        <p v-if="notice" role="status" class="text-xs">{{ notice }}</p>
        <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
        <section v-if="review" class="space-y-2 rounded border border-destructive/50 p-3">
          <h3 class="text-sm font-semibold">{{ t("mongoAggregation.review") }}</h3>
          <p class="text-xs">{{ t("mongoAggregation.reviewHint") }}</p>
          <p class="font-mono text-xs">{{ store.getConfig(review.endpoint.connectionId)?.name }} · {{ review.endpoint.database }} → {{ review.targetDatabase }}</p>
          <pre class="max-h-64 overflow-auto text-xs">{{ review.text }}</pre>
          <Button :disabled="writing" variant="destructive" @click="apply">{{ t("mongoAggregation.confirm") }}</Button>
          <Button :disabled="writing" variant="outline" class="ml-2" @click="review = null">{{ t("common.cancel") }}</Button>
        </section>
      </div>
      <DialogFooter class="border-t border-border px-4 py-3">
        <Button v-if="loading" variant="outline" @click="cancel">{{ t("common.cancel") }}</Button>
        <Button variant="outline" :disabled="!ready || !parsed.pipeline" @click="run()"><Play class="size-3" />{{ t("mongoAggregation.previewRun") }}</Button>
        <Button :disabled="!ready || !parsed.pipeline" @click="run(stages.length - 1, true)"><Play class="size-3" />{{ t("mongoAggregation.run") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
