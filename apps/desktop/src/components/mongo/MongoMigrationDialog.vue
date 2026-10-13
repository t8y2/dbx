<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import CompareConnectionSelect from "@/components/diff/CompareConnectionSelect.vue";
import MongoCompareEndpointSelect from "@/components/diff/MongoCompareEndpointSelect.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { saveTextFile } from "@/lib/export/saveTextFile";
import { mongoMigrationMessages } from "@/lib/mongo/mongoMigrationMessages";
import {
  assertMigrationMongoAck,
  executeMigrationOperations,
  isMigrationSqlType,
  migrationCheckSize,
  migrationMongoOperations,
  migrationReadSql,
  migrationSqlOperations,
  mongoRowsToSql,
  parseMigrationExtendedJson,
  sqlRowsToMongo,
  validateMigrationMappings,
  type MigrationDirection,
  type MigrationExecutionReport,
  type MigrationOperation,
  type MigrationSqlEndpoint,
  type MongoMigrationMapping,
} from "@/lib/mongo/mongoMigration";

const props = defineProps<{ prefillConnectionId?: string; prefillDatabase?: string; prefillCollection?: string }>();
const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n({ useScope: "local", messages: mongoMigrationMessages, inheritLocale: true, fallbackLocale: "en" });
const store = useConnectionStore();
const direction = ref<MigrationDirection>("sqlToMongo");
const mongo = ref({ connectionId: props.prefillConnectionId ?? "", database: props.prefillDatabase ?? "", collection: props.prefillCollection ?? "", filter: "{}" });
const sql = ref({ connectionId: "", database: "", schema: "", table: "" });
const limit = ref(100);
const mappings = ref<MongoMigrationMapping[]>([{ source: "id", target: "_id", type: "auto", array: "reject", missing: "error" }]);
const reading = ref(false);
const writing = ref(false);
const metadataLoading = ref(false);
const acknowledged = ref(false);
const error = ref("");
const notice = ref("");
const progress = ref(0);
const report = shallowRef<MigrationExecutionReport | null>(null);
interface Review {
  direction: MigrationDirection;
  mongo: typeof mongo.value;
  sql: MigrationSqlEndpoint;
  source: unknown[];
  rows: Record<string, unknown>[];
  operations: MigrationOperation[];
  readCommand: string;
  subset: boolean;
  target: { connectionId: string; database: string };
  configFingerprint: string;
}
const review = shallowRef<Review | null>(null);
const locked = computed(() => reading.value || writing.value || !!review.value);
const sqlConnections = computed(() => store.connections.filter((connection) => isMigrationSqlType(connection.db_type)));
const conversionTypes = computed(() => (direction.value === "mongoToSql" ? ["auto", "string", "ejson"] : ["auto", "string", "boolean", "int64", "decimal128", "date", "objectId", "ejson"]));
const commandText = computed(() => review.value?.operations.map((operation, index) => "-- " + (index + 1) + String.fromCharCode(10) + operation.text).join(String.fromCharCode(10, 10)) ?? "");
let generation = 0;
let executionId = "";
let controller: AbortController | undefined;
function describe(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
function cancel() {
  controller?.abort();
  // Do not abort an in-flight write: cancellation cannot prove that it was not committed.
  if (writing.value) return;
  generation++;
  if (executionId) void api.cancelQuery(executionId).catch(() => {});
  reading.value = false;
  review.value = null;
  acknowledged.value = false;
}
onBeforeUnmount(cancel);
watch(open, (visible) => {
  if (!visible) cancel();
});
watch(
  [direction, mongo, sql, mappings, limit],
  () => {
    if (!reading.value && !writing.value) {
      review.value = null;
      acknowledged.value = false;
      report.value = null;
      notice.value = "";
    }
  },
  { deep: true },
);
function switchDirection() {
  if (locked.value) return;
  direction.value = direction.value === "sqlToMongo" ? "mongoToSql" : "sqlToMongo";
  mappings.value = direction.value === "mongoToSql" ? [{ source: "_id", target: "id", type: "string", array: "reject", missing: "error" }] : [{ source: "id", target: "_id", type: "auto", array: "reject", missing: "error" }];
}
function changeSqlConnection(connectionId: string) {
  const config = store.getConfig(connectionId);
  sql.value = { connectionId, database: config?.database ?? "", schema: config?.default_schema ?? "", table: "" };
}
function writable(target: { connectionId: string }) {
  const config = store.getConfig(target.connectionId);
  if (!config || connectionIsEffectivelyReadOnly(config)) throw new Error(t("readOnly"));
}
async function preview() {
  if (locked.value || metadataLoading.value) return;
  error.value = "";
  notice.value = "";
  report.value = null;
  acknowledged.value = false;
  const request = ++generation;
  const mode = direction.value;
  const sourceMongo = { ...mongo.value };
  const dialect = store.getConfig(sql.value.connectionId)?.db_type;
  if (!isMigrationSqlType(dialect) || !sql.value.database || !sql.value.table || !sourceMongo.connectionId || !sourceMongo.database || !sourceMongo.collection) {
    error.value = t("missingEndpoint");
    return;
  }
  const sourceSql: MigrationSqlEndpoint = { ...sql.value, dialect };
  const target = mode === "sqlToMongo" ? sourceMongo : sourceSql;
  const configFingerprint = JSON.stringify(store.getConfig(target.connectionId));
  controller = new AbortController();
  const signal = controller.signal;
  const valid = () => {
    signal.throwIfAborted();
    if (request !== generation || !open.value) throw new Error("Cancelled");
  };
  reading.value = true;
  executionId = uuid();
  try {
    const rules = validateMigrationMappings(JSON.parse(JSON.stringify(mappings.value)), mode);
    const readSql = migrationReadSql(sourceSql, limit.value);
    writable(target);
    await store.ensureConnected(sourceSql.connectionId);
    valid();
    await store.ensureConnected(sourceMongo.connectionId);
    valid();
    let source: unknown[];
    let rows: Record<string, unknown>[];
    let operations: MigrationOperation[];
    let subset = false;
    let readCommand = readSql;
    if (mode === "sqlToMongo") {
      const collections = await api.mongoListCollections(sourceMongo.connectionId, sourceMongo.database);
      valid();
      if (!collections.some((collection) => collection.name === sourceMongo.collection && collection.kind !== "bucket")) throw new Error(t("missingEndpoint"));
      const result = await api.executeQuery(sourceSql.connectionId, sourceSql.database, readSql, sourceSql.schema, executionId, { maxRows: limit.value + 1, timeoutSecs: 60 });
      if (result.session_id) void api.closeQuerySession(sourceSql.connectionId, sourceSql.database, result.session_id).catch(() => {});
      valid();
      if (result.execution_error) throw new Error(JSON.stringify(result.error));
      subset = result.rows.length > limit.value || result.has_more === true || result.truncated === true;
      const bounded = { ...result, rows: result.rows.slice(0, limit.value) };
      source = bounded.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
      migrationCheckSize(source);
      rows = sqlRowsToMongo(bounded, rules);
      operations = migrationMongoOperations(rows, sourceMongo.collection);
    } else {
      const filter: unknown = parseMigrationExtendedJson(sourceMongo.filter || "{}");
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("Mongo filter must be a JSON object");
      const pipeline = [{ $match: filter }, { $limit: limit.value + 1 }];
      readCommand = JSON.stringify({ aggregate: sourceMongo.collection, pipeline, cursor: {}, maxTimeMS: 60000 });
      const result = await api.mongoAggregateDocuments(sourceMongo.connectionId, sourceMongo.database, sourceMongo.collection, JSON.stringify(pipeline), limit.value + 1, '{"maxTimeMS":60000}', executionId);
      valid();
      if (!result.extended_documents || result.extended_documents.length !== result.documents.length) throw new Error(t("bsonMissing"));
      subset = result.documents.length > limit.value;
      source = result.extended_documents.slice(0, limit.value);
      migrationCheckSize(source);
      rows = mongoRowsToSql(source, rules);
      const columns = await api.getColumns(sourceSql.connectionId, sourceSql.database, sourceSql.schema, sourceSql.table);
      valid();
      operations = migrationSqlOperations(rows, sourceSql, columns);
    }
    valid();
    migrationCheckSize(source);
    if (!rows.length) {
      notice.value = t("empty");
      return;
    }
    if (configFingerprint !== JSON.stringify(store.getConfig(target.connectionId))) throw new Error(t("metadataChanged"));
    review.value = { direction: mode, mongo: sourceMongo, sql: sourceSql, source, rows, operations, readCommand, subset, target, configFingerprint };
    notice.value = t("snapshot", { count: rows.length });
  } catch (cause) {
    if (request === generation && !signal.aborted) error.value = describe(cause);
  } finally {
    if (request === generation) {
      reading.value = false;
      executionId = "";
    }
  }
}
async function exportPlan() {
  if (!review.value) return;
  try {
    await saveTextFile(JSON.stringify({ version: 1, direction: review.value.direction, target: review.value.target, mappings: mappings.value, operations: review.value.operations }, null, 2), "mongo-migration-plan.json", "JSON", "json");
  } catch (cause) {
    error.value = describe(cause);
  }
}
async function apply() {
  const plan = review.value;
  if (!plan || !acknowledged.value || reading.value || writing.value) return;
  writing.value = true;
  error.value = "";
  progress.value = 0;
  controller = new AbortController();
  const signal = controller.signal;
  let dispatched = false;
  const checkTarget = () => {
    writable(plan.target);
    if (JSON.stringify(store.getConfig(plan.target.connectionId)) !== plan.configFingerprint) throw new Error(t("metadataChanged"));
  };
  try {
    checkTarget();
    const config = store.getConfig(plan.target.connectionId);
    if ((plan.direction === "sqlToMongo" && config?.db_type !== "mongodb") || (plan.direction === "mongoToSql" && config?.db_type !== plan.sql.dialect)) throw new Error(t("missingEndpoint"));
    await store.ensureConnected(plan.target.connectionId);
    signal.throwIfAborted();
    if (plan.direction === "mongoToSql") {
      const columns = await api.getColumns(plan.sql.connectionId, plan.sql.database, plan.sql.schema, plan.sql.table);
      signal.throwIfAborted();
      if (JSON.stringify(migrationSqlOperations(plan.rows, plan.sql, columns)) !== JSON.stringify(plan.operations)) throw new Error(t("metadataChanged"));
    } else {
      const collections = await api.mongoListCollections(plan.mongo.connectionId, plan.mongo.database);
      signal.throwIfAborted();
      if (!collections.some((collection) => collection.name === plan.mongo.collection && collection.kind !== "bucket")) throw new Error(t("missingEndpoint"));
    }
    const outcome = await executeWithProductionContextGuard({
      connection: config,
      database: plan.target.database,
      reviewText: commandText.value,
      source: t("title"),
      execute: async () => {
        signal.throwIfAborted();
        dispatched = true;
        return executeMigrationOperations(
          plan.operations,
          async (operation) => {
            if (operation.kind === "mongo") {
              const result = await api.mongoRunCommand(plan.target.connectionId, plan.target.database, operation.text);
              assertMigrationMongoAck(result.documents[0]);
            } else {
              const result = await api.executeQuery(plan.sql.connectionId, plan.sql.database, operation.text, plan.sql.schema, uuid(), { timeoutSecs: 60 });
              if (result.execution_error || result.affected_rows !== 1) throw new Error(JSON.stringify(result.error ?? "Expected 1 affected row, got " + result.affected_rows));
            }
          },
          {
            signal,
            beforeWrite: checkTarget,
            onProgress: (count) => {
              progress.value = count;
            },
          },
        );
      },
    });
    if (outcome) {
      report.value = outcome;
      notice.value = t("completed", { completed: outcome.completed, total: outcome.total, status: outcome.status });
      if (outcome.error) error.value = outcome.error;
    }
  } catch (cause) {
    if (!signal.aborted) error.value = describe(cause);
  } finally {
    writing.value = false;
    acknowledged.value = false;
    if (dispatched) review.value = null;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[min(900px,calc(100dvh-2rem))] max-w-[min(1400px,calc(100vw-2rem))] flex-col gap-0 p-0" :show-close-button="!writing" @escape-key-down="writing && $event.preventDefault()" @interact-outside.prevent>
      <DialogHeader class="border-b border-border px-5 py-4"
        ><DialogTitle>{{ t("title") }}</DialogTitle
        ><DialogDescription>{{ t("subtitle") }}</DialogDescription></DialogHeader
      >
      <div class="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <div class="flex flex-wrap items-center gap-3">
          <Button variant="outline" :disabled="locked" @click="switchDirection">{{ t(direction) }} ⇄</Button><label class="flex items-center gap-2 text-xs">{{ t("limit") }}<Input v-model.number="limit" type="number" min="1" max="1000" class="h-8 w-24" :disabled="locked" /></label>
        </div>
        <div class="grid gap-3 lg:grid-cols-2">
          <section class="space-y-2 rounded-md border border-border p-3">
            <h3 class="text-sm font-semibold">{{ t("sqlEndpoint") }}</h3>
            <CompareConnectionSelect :model-value="sql.connectionId" :connections="sqlConnections" :layout="store.sidebarLayout" :disabled="locked" @update:model-value="changeSqlConnection" />
            <div class="grid gap-2 sm:grid-cols-3">
              <label v-for="field in ['database', 'schema', 'table'] as const" :key="field" class="space-y-1 text-xs">{{ t(field) }}<Input v-model="sql[field]" :disabled="locked" class="h-8" /></label>
            </div>
          </section>
          <MongoCompareEndpointSelect v-model="mongo" :label="t('mongoEndpoint')" :disabled="locked" :hide-filter="direction === 'sqlToMongo'" @loading="metadataLoading = $event" />
        </div>
        <section class="space-y-2">
          <h3 class="text-sm font-semibold">{{ t("mapping") }}</h3>
          <p class="text-xs text-muted-foreground">{{ t("mappingHint") }}</p>
          <fieldset :disabled="locked" class="space-y-2">
            <legend class="sr-only">{{ t("mapping") }}</legend>
            <div v-for="(mapping, index) in mappings" :key="index" class="flex flex-wrap items-end gap-2 rounded border border-border p-2">
              <label class="min-w-32 flex-1 space-y-1 text-xs">{{ t("source") }}<Input v-model="mapping.source" class="h-8 font-mono" /></label>
              <label class="min-w-32 flex-1 space-y-1 text-xs">{{ t("target") }}<Input v-model="mapping.target" class="h-8 font-mono" /></label>
              <label class="space-y-1 text-xs"
                >{{ t("type")
                }}<select v-model="mapping.type" class="block h-8 rounded border border-input bg-background px-2">
                  <option v-for="type in conversionTypes" :key="type" :value="type">{{ t(type) }}</option>
                </select></label
              >
              <template v-if="direction === 'mongoToSql'"
                ><label class="space-y-1 text-xs"
                  >{{ t("array")
                  }}<select v-model="mapping.array" class="block h-8 rounded border border-input bg-background px-2">
                    <option v-for="value in ['reject', 'json', 'first']" :key="value" :value="value">{{ t(value) }}</option>
                  </select></label
                ><label class="space-y-1 text-xs"
                  >{{ t("missing")
                  }}<select v-model="mapping.missing" class="block h-8 rounded border border-input bg-background px-2">
                    <option v-for="value in ['error', 'null', 'omit']" :key="value" :value="value">{{ t(value) }}</option>
                  </select></label
                ></template
              >
              <Button size="sm" variant="ghost" :disabled="locked || mappings.length === 1" @click="mappings.splice(index, 1)">{{ t("remove") }}</Button>
            </div>
          </fieldset>
          <Button size="sm" variant="outline" :disabled="locked || mappings.length >= 100" @click="mappings.push({ source: '', target: '', type: 'auto', array: 'reject', missing: 'error' })">{{ t("add") }}</Button>
        </section>
        <p class="rounded border border-border bg-muted/30 p-3 text-xs text-muted-foreground">{{ t("boundary") }}</p>
        <p v-if="notice" role="status" class="text-xs">{{ notice }}</p>
        <p v-if="error" role="alert" class="break-all text-xs text-destructive">{{ error }}</p>
        <p v-if="report?.uncertainIndex" role="alert" class="text-xs text-destructive">{{ t("uncertain", { index: report.uncertainIndex }) }}</p>
        <section v-if="review" class="space-y-3">
          <p class="font-mono text-xs">
            {{ store.getConfig(review.target.connectionId)?.name }} · {{ review.target.database }} ·
            {{ review.direction === "sqlToMongo" ? review.mongo.collection : [review.sql.schema, review.sql.table].filter(Boolean).join(".") }}
          </p>
          <p v-if="review.subset" role="alert" class="rounded border border-destructive/50 p-2 text-xs">{{ t("subset") }}</p>
          <details>
            <summary class="cursor-pointer text-xs">{{ t("readCommand") }}</summary>
            <pre class="overflow-auto text-xs">{{ review.readCommand }}</pre>
          </details>
          <div class="grid gap-3 lg:grid-cols-2">
            <div>
              <h4 class="text-xs font-semibold">{{ t("sourcePreview") }}</h4>
              <pre class="mt-1 max-h-64 overflow-auto rounded border border-border p-2 text-xs">{{ JSON.stringify(review.source.slice(0, 50), null, 2) }}</pre>
            </div>
            <div>
              <h4 class="text-xs font-semibold">{{ t("resultPreview") }}</h4>
              <pre class="mt-1 max-h-64 overflow-auto rounded border border-border p-2 text-xs">{{ JSON.stringify(review.rows.slice(0, 50), null, 2) }}</pre>
            </div>
          </div>
          <h4 class="text-xs font-semibold">{{ t("commands") }}</h4>
          <pre class="max-h-72 overflow-auto rounded border border-border p-2 text-xs">{{ commandText }}</pre>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" :disabled="writing" @click="exportPlan">{{ t("export") }}</Button
            ><Button
              size="sm"
              variant="outline"
              :disabled="writing"
              @click="
                review = null;
                acknowledged = false;
              "
              >{{ t("clear") }}</Button
            >
          </div>
          <label class="flex items-start gap-2 rounded border border-destructive/50 p-3 text-xs"><input v-model="acknowledged" type="checkbox" :disabled="writing" />{{ t("acknowledge") }}</label>
        </section>
      </div>
      <DialogFooter class="items-center border-t border-border px-4 py-3">
        <span v-if="reading" role="status" class="text-xs">{{ t("waiting") }}</span
        ><span v-if="writing" role="status" class="text-xs">{{ t("working") }} {{ progress }}/{{ review?.operations.length }}</span>
        <Button v-if="reading || writing" variant="outline" @click="cancel">{{ t(writing ? "stop" : "cancel") }}</Button>
        <Button v-if="!review" :disabled="locked || metadataLoading" @click="preview">{{ t("preview") }}</Button
        ><Button v-else variant="destructive" :disabled="!acknowledged || writing" @click="apply">{{ t("confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
