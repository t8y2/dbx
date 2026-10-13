<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import MongoCompareEndpointSelect from "@/components/diff/MongoCompareEndpointSelect.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { parseMongoJson } from "@/lib/mongo/mongoJson";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { uuid } from "@/lib/common/utils";
import { saveTextFile } from "@/lib/export/saveTextFile";
import * as api from "@/lib/backend/api";
import { compareMongoDocuments, mongoCompareFingerprint, planMongoSync, type MongoCompareDocument, type MongoSyncChange } from "@/lib/mongo/mongoCompare";
import { executeMongoSync, mongoSyncCommand, readMongoCompareSnapshot, type MongoCompareEndpoint } from "@/lib/mongo/mongoCompareRuntime";
import { transformMongoDocuments, type MongoTransformAction, type MongoTransformRule } from "@/lib/mongo/mongoTransform";
import { validateMongoOutputName } from "@/lib/mongo/mongoAggregation";

const props = defineProps<{ prefillConnectionId?: string; prefillDatabase?: string; prefillCollection?: string }>();
const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const store = useConnectionStore();
const empty = (): MongoCompareEndpoint => ({ connectionId: "", database: "", collection: "", filter: "{}" });
const source = ref({ ...empty(), connectionId: props.prefillConnectionId ?? "", database: props.prefillDatabase ?? "", collection: props.prefillCollection ?? "" });
const target = ref(empty());
const rules = ref([{ id: uuid(), path: "", action: "redact" as MongoTransformAction, value: '""', destination: "" }]);
const secret = ref("");
const limit = ref(1000);
const loading = ref(false);
const writing = ref(false);
const error = ref("");
const notice = ref("");
const completed = ref(0);
const page = ref(0);
const snapshot = shallowRef<{ source: MongoCompareEndpoint; original: MongoCompareDocument[]; transformed: MongoCompareDocument[] } | null>(null);
const review = shallowRef<{ target: MongoCompareEndpoint; changes: MongoSyncChange[]; text: string } | null>(null);
const locked = computed(() => loading.value || writing.value || !!review.value);
const visible = computed(() => snapshot.value?.transformed.slice(page.value * 20, (page.value + 1) * 20) ?? []);
let controller: AbortController | undefined;
let executionId = "";
let generation = 0;
function cancel() {
  generation++;
  controller?.abort();
  if (executionId && !writing.value) void api.cancelQuery(executionId).catch(() => {});
  loading.value = false;
  review.value = null;
}
onBeforeUnmount(cancel);
watch(open, (v) => {
  if (!v) cancel();
});
watch(
  [source, rules, limit, secret],
  () => {
    snapshot.value = null;
    review.value = null;
    notice.value = "";
    page.value = 0;
  },
  { deep: true },
);
watch(
  target,
  () => {
    review.value = null;
  },
  { deep: true },
);
function addRule() {
  rules.value.push({ id: uuid(), path: "", action: "redact", value: '""', destination: "" });
}
function parsedRules(): MongoTransformRule[] {
  return rules.value.map((rule) => ({
    path: rule.path,
    action: rule.action,
    destination: rule.destination,
    ...(rule.action === "replace" ? { value: parseMongoJson(rule.value) } : {}),
  }));
}
async function preview() {
  if (locked.value || !source.value.collection) return;
  loading.value = true;
  error.value = "";
  notice.value = "";
  snapshot.value = null;
  page.value = 0;
  const request = ++generation;
  controller = new AbortController();
  executionId = uuid();
  const endpoint = { ...source.value };
  try {
    const transformations = parsedRules();
    await store.ensureConnected(endpoint.connectionId);
    if (request !== generation) return;
    const data = await readMongoCompareSnapshot(api, endpoint, { limit: limit.value, executionId, signal: controller.signal });
    if (data.truncated) throw new Error(t("mongoTransform.truncated"));
    const transformed = await transformMongoDocuments(data.documents, transformations, { secret: secret.value, signal: controller.signal });
    if (request === generation) snapshot.value = { source: endpoint, original: data.documents, transformed };
  } catch (cause) {
    if (request === generation) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (request === generation) loading.value = false;
  }
}
function prepare() {
  if (!snapshot.value || locked.value) return;
  error.value = "";
  try {
    const destination = { ...target.value };
    try {
      if (!destination.connectionId) throw new Error();
      validateMongoOutputName(destination.database, "database");
      validateMongoOutputName(destination.collection, "collection");
    } catch {
      throw new Error(t("mongoAggregation.outputTarget"));
    }
    if (connectionIsEffectivelyReadOnly(store.getConfig(destination.connectionId))) throw new Error(t("mongoAggregation.outputReadOnly"));
    if (destination.connectionId === snapshot.value.source.connectionId && destination.database === snapshot.value.source.database && destination.collection === snapshot.value.source.collection) throw new Error(t("mongoTransform.differentTarget"));
    const compared = compareMongoDocuments(snapshot.value.transformed, [], { matchFields: ["_id"] });
    if (compared.counts.multiple) throw new Error(t("mongoTransform.uniqueIds"));
    const originals = new Map(snapshot.value.original.map((doc) => [mongoCompareFingerprint(doc._id), doc]));
    const changes = compared.rows.map((row) => ({ ...planMongoSync(row, "target")!, origin: originals.get(mongoCompareFingerprint(row.source!._id)) }));
    review.value = {
      target: destination,
      changes,
      text: JSON.stringify(
        changes.map((change) => mongoSyncCommand(destination.collection, change)),
        null,
        2,
      ),
    };
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function apply() {
  const plan = review.value;
  const data = snapshot.value;
  if (!plan || !data || writing.value) return;
  writing.value = true;
  error.value = "";
  completed.value = 0;
  const request = generation;
  controller = new AbortController();
  const signal = controller.signal;
  try {
    await store.ensureConnected(plan.target.connectionId);
    const done = await executeWithProductionContextGuard({
      connection: store.getConfig(plan.target.connectionId),
      database: plan.target.database,
      reviewText: plan.text,
      source: t("mongoTransform.title"),
      execute: async () => {
        if (request !== generation || !open.value) return false;
        await executeMongoSync(
          api,
          data.source,
          plan.target,
          ["_id"],
          plan.changes,
          (count) => {
            completed.value = count;
          },
          signal,
        );
        return true;
      },
    });
    if (done) notice.value = t("mongoTransform.applied", { count: completed.value });
  } catch (cause) {
    error.value = String(cause);
    notice.value = t("mongoCompare.syncStopped", { count: completed.value });
  } finally {
    writing.value = false;
    review.value = null;
    snapshot.value = null;
  }
}
async function exportDocuments() {
  try {
    if (snapshot.value) await saveTextFile(JSON.stringify(snapshot.value.transformed, null, 2), "mongo-transformed.json", "JSON", "json");
  } catch (cause) {
    error.value = String(cause);
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
    <DialogContent :show-close-button="!writing" class="flex h-[min(900px,calc(100dvh-2rem))] max-w-[min(1300px,calc(100vw-2rem))] flex-col gap-0 p-0" @interact-outside.prevent @escape-key-down="(e) => writing && e.preventDefault()">
      <DialogHeader class="border-b border-border px-5 py-4"
        ><DialogTitle>{{ t("mongoTransform.title") }}</DialogTitle>
        <p class="text-xs text-muted-foreground">{{ t("mongoTransform.subtitle") }}</p></DialogHeader
      >
      <div class="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        <div class="grid gap-3 lg:grid-cols-2">
          <MongoCompareEndpointSelect v-model="source" :disabled="locked" :label="t('mongoCompare.source')" />
          <div class="space-y-2">
            <MongoCompareEndpointSelect v-model="target" :disabled="locked" :label="t('mongoCompare.target')" database-only hide-filter /><label class="block text-xs">{{ t("mongoTransform.destination") }}<Input v-model="target.collection" :disabled="locked" /></label>
          </div>
        </div>
        <fieldset :disabled="locked" class="space-y-2">
          <legend class="mb-2 text-sm font-semibold">{{ t("mongoTransform.rules") }}</legend>
          <p class="text-xs text-muted-foreground">{{ t("mongoTransform.pathHint") }}</p>
          <div v-for="(rule, index) in rules" :key="rule.id" class="flex flex-wrap items-center gap-2">
            <Input v-model="rule.path" :aria-label="t('mongoTransform.path')" :placeholder="t('mongoTransform.path')" class="min-w-32 flex-1" />
            <Select v-model="rule.action" :disabled="locked"
              ><SelectTrigger class="w-36" :aria-label="t('mongoTransform.action')"><SelectValue /></SelectTrigger
              ><SelectContent
                ><SelectItem v-for="action in ['redact', 'hash', 'remove', 'replace', 'copy', 'rename']" :key="action" :value="action">{{ t("mongoTransform.actions." + action) }}</SelectItem></SelectContent
              ></Select
            >
            <Input v-if="rule.action === 'replace'" v-model="rule.value" :aria-label="t('mongoTransform.value')" :placeholder="t('mongoTransform.value')" class="min-w-32 flex-1 font-mono" />
            <Input v-if="rule.action === 'copy' || rule.action === 'rename'" v-model="rule.destination" :aria-label="t('mongoTransform.destinationPath')" :placeholder="t('mongoTransform.destinationPath')" class="min-w-32 flex-1" />
            <Button variant="ghost" :disabled="locked || rules.length < 2" @click="rules.splice(index, 1)">{{ t("common.delete") }}</Button>
          </div>
          <Button variant="outline" :disabled="locked || rules.length >= 100" @click="addRule">{{ t("mongoTransform.addRule") }}</Button>
          <label v-if="rules.some((r) => r.action === 'hash')" class="block text-xs">{{ t("mongoTransform.secret") }}<Input v-model="secret" type="password" autocomplete="off" /></label>
          <label class="flex items-center gap-2 text-xs">{{ t("mongoCompare.limit") }}<Input v-model.number="limit" class="w-28" type="number" min="1" max="100000" /></label>
        </fieldset>
        <div v-if="snapshot" class="space-y-2">
          <p class="text-xs">{{ t("mongoTransform.previewCount", { count: snapshot.transformed.length }) }}</p>
          <div class="grid gap-3 lg:grid-cols-2">
            <pre class="max-h-80 overflow-auto rounded border border-border p-2 text-xs">{{ JSON.stringify(snapshot.original.slice(page * 20, (page + 1) * 20), null, 2) }}</pre>
            <pre class="max-h-80 overflow-auto rounded border border-border p-2 text-xs">{{ JSON.stringify(visible, null, 2) }}</pre>
          </div>
          <div class="flex gap-2">
            <Button variant="outline" :disabled="page === 0" :aria-label="t('mongoTransform.previous')" @click="page--">←</Button><span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(snapshot.transformed.length / 20)) }}</span
            ><Button variant="outline" :disabled="(page + 1) * 20 >= snapshot.transformed.length" :aria-label="t('mongoTransform.next')" @click="page++">→</Button><Button variant="outline" @click="exportDocuments">{{ t("mongoSchema.export") }}</Button>
          </div>
        </div>
        <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
        <p v-if="notice" role="status" class="text-xs">{{ notice }}</p>
        <section v-if="review" class="space-y-2 rounded border border-destructive/50 p-3">
          <h3 class="font-semibold">{{ t("mongoTransform.review") }} · {{ store.getConfig(review.target.connectionId)?.name }} / {{ review.target.database }}.{{ review.target.collection }}</h3>
          <p class="text-xs">{{ t("mongoTransform.reviewHint") }}</p>
          <pre class="max-h-64 overflow-auto text-xs">{{ review.text }}</pre>
          <Button :disabled="writing" variant="destructive" @click="apply">{{ t("mongoAggregation.confirm") }}</Button
          ><Button :disabled="writing" variant="outline" class="ml-2" @click="review = null">{{ t("common.cancel") }}</Button>
        </section>
      </div>
      <DialogFooter class="border-t border-border p-4"
        ><Button v-if="loading" variant="outline" @click="cancel">{{ t("common.cancel") }}</Button
        ><Button :disabled="locked" variant="outline" @click="preview">{{ t("mongoTransform.preview") }}</Button
        ><Button :disabled="locked || !snapshot?.transformed.length" @click="prepare">{{ t("mongoTransform.review") }}</Button></DialogFooter
      >
    </DialogContent>
  </Dialog>
</template>
