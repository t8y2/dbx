<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import MongoCompareEndpointSelect from "@/components/diff/MongoCompareEndpointSelect.vue";
import { mongoScriptOperation } from "@/lib/mongo/mongoScriptProtocol";
import { runMongoScriptSandbox, type MongoScriptSession } from "@/lib/mongo/mongoScriptSandbox";
import { canonicalDocuments } from "@/lib/mongo/mongoCompareRuntime";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { saveTextFile } from "@/lib/export/saveTextFile";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";

const props = defineProps<{ prefillConnectionId?: string; prefillDatabase?: string; prefillCollection?: string }>();
const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const store = useConnectionStore();
const endpoint = ref({ connectionId: props.prefillConnectionId ?? "", database: props.prefillDatabase ?? "", collection: props.prefillCollection ?? "", filter: "{}" });
const source = ref("const collection = db.getCollection(" + JSON.stringify(props.prefillCollection || "collection") + ");\nconst documents = await collection.find({}).limit(20).toArray();\nfor (const document of documents) {\n  printjson(document);\n}\n");
const logs = shallowRef<string[]>([]);
const running = ref(false);
const error = ref("");
const status = ref("");
const review = shallowRef<{ text: string; database: string } | null>(null);
const fileInput = ref<HTMLInputElement>();
let session: MongoScriptSession | undefined;
let decide: ((value: boolean) => void) | undefined;
let executionId = "";
let generation = 0;
function decideWrite(value: boolean) {
  const callback = decide;
  decide = undefined;
  review.value = null;
  callback?.(value);
}
function cancel() {
  generation++;
  decideWrite(false);
  session?.cancel();
  if (executionId) void api.cancelQuery(executionId).catch(() => {});
  if (running.value) status.value = t("mongoScript.cancelled");
  running.value = false;
}
onBeforeUnmount(cancel);
watch(open, (value) => {
  if (!value) cancel();
});
async function run() {
  if (running.value || !endpoint.value.connectionId || !endpoint.value.database) return;
  running.value = true;
  error.value = "";
  status.value = "";
  logs.value = [];
  const current = { ...endpoint.value };
  const requestGeneration = ++generation;
  try {
    await store.ensureConnected(current.connectionId);
    if (requestGeneration !== generation) return;
    session = runMongoScriptSandbox(source.value, {
      log: (values) => {
        logs.value = [...logs.value, values.map((value) => JSON.stringify(value)).join(" ")].slice(-1000);
      },
      request: async (input, signal) => {
        signal.throwIfAborted();
        const { operation } = mongoScriptOperation(input, current.database);
        const id = uuid();
        executionId = id;
        const abortQuery = () => {
          void api.cancelQuery(id).catch(() => {});
        };
        signal.addEventListener("abort", abortQuery, { once: true });
        try {
          if (operation.kind === "find") {
            const pipeline: Record<string, unknown>[] = [{ $match: JSON.parse(operation.filter) }];
            const sort = JSON.parse(operation.sort);
            if (Object.keys(sort).length) pipeline.push({ $sort: sort });
            if (operation.skip) pipeline.push({ $skip: operation.skip });
            pipeline.push({ $limit: operation.limit });
            const projection = JSON.parse(operation.projection);
            if (Object.keys(projection).length) pipeline.push({ $project: projection });
            const value = await api.mongoAggregateDocuments(current.connectionId, current.database, operation.collection, JSON.stringify(pipeline), operation.limit, '{"maxTimeMS":60000}', id);
            return canonicalDocuments(value);
          }
          if (operation.kind === "aggregate") {
            const value = await api.mongoAggregateDocuments(current.connectionId, current.database, operation.collection, operation.pipeline, operation.limit, '{"maxTimeMS":60000}', id);
            return canonicalDocuments(value);
          }
          if (operation.kind === "count") {
            const response = await api.mongoAggregateDocuments(current.connectionId, current.database, operation.collection, JSON.stringify([{ $match: JSON.parse(operation.filter) }, { $count: "count" }]), 1, '{"maxTimeMS":60000}', id);
            const count = (response.documents[0] as Record<string, unknown> | undefined)?.count ?? 0;
            if (typeof count !== "number" || !Number.isSafeInteger(count)) throw new Error("Count exceeds safe integer precision");
            return count;
          }
          if (connectionIsEffectivelyReadOnly(store.getConfig(current.connectionId))) throw new Error(t("mongoAggregation.outputReadOnly"));
          signal.throwIfAborted();
          const confirmed = await new Promise<boolean>((resolve) => {
            const abort = () => decideWrite(false);
            signal.addEventListener("abort", abort, { once: true });
            decide = (value) => {
              signal.removeEventListener("abort", abort);
              resolve(value);
            };
            review.value = { text: JSON.stringify(JSON.parse(operation.command), null, 2), database: operation.targetDatabase };
          });
          if (!confirmed) throw new Error("Write cancelled");
          signal.throwIfAborted();
          const executeWrite = () =>
            executeWithProductionContextGuard({
              connection: store.getConfig(current.connectionId),
              database: operation.targetDatabase,
              reviewText: operation.command,
              source: t("mongoScript.title"),
              execute: async () => {
                signal.throwIfAborted();
                if (connectionIsEffectivelyReadOnly(store.getConfig(current.connectionId))) throw new Error(t("mongoAggregation.outputReadOnly"));
                const response = await api.mongoRunCommand(current.connectionId, current.database, operation.command, id);
                const result = response.documents[0] as Record<string, unknown> | undefined;
                if (!result || result.ok !== 1 || (Array.isArray(result.writeErrors) && result.writeErrors.length) || result.writeConcernError) throw new Error(JSON.stringify(result ?? "Missing write response"));
                return canonicalDocuments(response)[0];
              },
            });
          // Cross-database output must not evade the selected source's production scope.
          const value =
            operation.targetDatabase === current.database
              ? await executeWrite()
              : await executeWithProductionContextGuard({
                  connection: store.getConfig(current.connectionId),
                  database: current.database,
                  reviewText: operation.command,
                  source: t("mongoScript.title"),
                  execute: async () => {
                    signal.throwIfAborted();
                    return executeWrite();
                  },
                });
          if (value === undefined) throw new Error("Write cancelled");
          return value;
        } finally {
          signal.removeEventListener("abort", abortQuery);
          if (executionId === id) executionId = "";
        }
      },
    });
    await session.completion;
    if (requestGeneration === generation) status.value = t("mongoScript.complete");
  } catch (cause) {
    if (requestGeneration === generation) error.value = String(cause);
  } finally {
    if (requestGeneration === generation) {
      running.value = false;
      decideWrite(false);
    }
  }
}
async function save() {
  try {
    await saveTextFile(source.value, "mongo-script.js", "JavaScript", "js");
  } catch (cause) {
    error.value = String(cause);
  }
}
async function load(event: Event) {
  try {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file || running.value) return;
    if (file.size > 100000) throw new Error("Script exceeds 100,000 bytes");
    const value = await file.text();
    if (!running.value) source.value = value;
  } catch (cause) {
    error.value = String(cause);
  } finally {
    if (fileInput.value) fileInput.value.value = "";
  }
}
</script>
<template>
  <Dialog v-model:open="open"
    ><DialogContent class="flex h-[min(850px,calc(100dvh-2rem))] max-w-[min(1300px,calc(100vw-2rem))] flex-col gap-0 p-0">
      <DialogHeader class="border-b border-border p-4"
        ><DialogTitle>{{ t("mongoScript.title") }}</DialogTitle>
        <p class="text-xs text-muted-foreground">{{ t("mongoScript.subtitle") }}</p></DialogHeader
      >
      <div class="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        <MongoCompareEndpointSelect v-model="endpoint" :disabled="running" :label="t('mongoCompare.source')" database-only hide-filter />
        <p class="text-xs">{{ t("mongoScript.help") }}</p>
        <textarea v-model="source" :disabled="running" aria-label="JavaScript" spellcheck="false" class="min-h-64 w-full rounded border border-input bg-transparent p-3 font-mono text-xs focus-visible:outline-ring" />
        <pre class="max-h-64 overflow-auto rounded border border-border p-2 text-xs" aria-live="polite">{{ logs.join("\n") || t("mongoScript.empty") }}</pre>
        <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
        <p v-if="status" role="status" class="text-xs">{{ status }}</p>
        <section v-if="review" class="space-y-2 rounded border border-destructive/50 p-3">
          <h3 class="font-semibold">{{ t("mongoAggregation.review") }} · {{ review.database }}</h3>
          <p class="text-xs">{{ t("mongoScript.writeHint") }}</p>
          <pre class="max-h-48 overflow-auto text-xs">{{ review.text }}</pre>
          <Button variant="destructive" @click="decideWrite(true)">{{ t("mongoAggregation.confirm") }}</Button
          ><Button class="ml-2" variant="outline" @click="decideWrite(false)">{{ t("common.cancel") }}</Button>
        </section>
      </div>
      <DialogFooter class="border-t border-border p-4"
        ><input ref="fileInput" type="file" accept=".js,.txt" class="hidden" @change="load" /><Button :disabled="running" variant="outline" @click="fileInput?.click()">{{ t("mongoScript.import") }}</Button
        ><Button variant="outline" @click="save">{{ t("mongoScript.save") }}</Button
        ><Button v-if="running" variant="outline" @click="cancel">{{ t("common.cancel") }}</Button
        ><Button :disabled="running || !endpoint.database" @click="run">{{ t("mongoScript.run") }}</Button></DialogFooter
      >
    </DialogContent></Dialog
  >
</template>
