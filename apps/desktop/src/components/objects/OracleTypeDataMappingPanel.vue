<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { executeOracleTypeDataInsert, prepareOracleTypeDataInsert, verifyOracleTypeDataMappings } from "@/lib/table/oracleTypeDataMapping";
import { registerOracleTypeDataMapping, type OracleTypeManagementDraft } from "@/lib/table/oracleTypeManagement";
import type { OracleTypeDataMappingInput, OracleTypeDataRelationKey } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

const props = defineProps<{ plan: OracleTypeManagementDraft; disabled: boolean; persist: (plan: OracleTypeManagementDraft) => Promise<void>; isCurrent: () => boolean }>();
const emit = defineEmits<{ update: [plan: OracleTypeManagementDraft]; busy: [busy: boolean] }>();
const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const working = ref(false);
let saves: Promise<void> = Promise.resolve();
let savesPending = 0;
let previousInsertDrafts: Record<string, string> = {};
const error = ref("");
const preparation = ref<OracleTypeDataMappingInput>();
const targetPaths = ref<string[]>([]);
const insertDrafts = ref<Record<string, string>>({});
const sourceIndex = ref(0);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sources = computed<OracleTypeDataRelationKey[]>(() => [...new Map(props.plan.originalSnapshot.persistentReferences.map((reference) => [JSON.stringify([reference.owner, reference.tableName]), { owner: reference.owner, name: reference.tableName }])).values()]);
const availableSources = computed(() => sources.value.filter((source) => !props.plan.dataMappings.some((record) => record.manifest.mapping.source.owner === source.owner && record.manifest.mapping.source.name === source.name)));
const locked = computed(() => props.disabled || working.value);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const label = (key: OracleTypeDataRelationKey) => `${quote(key.owner)}.${quote(key.name)}`;

watch(
  () => props.plan,
  (plan) => {
    if (preparation.value?.id !== plan.dataPreparation?.id) {
      preparation.value = plan.dataPreparation && clone(plan.dataPreparation);
      targetPaths.value = plan.dataTargetPaths ? [...plan.dataTargetPaths] : (preparation.value?.fields.map((field) => JSON.stringify(field.targetPath)) ?? []);
    }
    const incoming = Object.fromEntries(plan.dataMappings.map((record) => [record.manifest.mapping.id, record.insertDraft ?? record.insertSql]));
    for (const [id, text] of Object.entries(incoming)) if (insertDrafts.value[id] === undefined || insertDrafts.value[id] === previousInsertDrafts[id]) insertDrafts.value[id] = text;
    previousInsertDrafts = incoming;
  },
  { immediate: true },
);

async function run(action: () => Promise<void>) {
  if (locked.value) return;
  working.value = true;
  emit("busy", true);
  error.value = "";
  try {
    await saves;
    await nextTick();
    await action();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    working.value = false;
    emit("busy", savesPending > 0);
  }
}
async function save(plan: OracleTypeManagementDraft) {
  await props.persist(plan);
  emit("update", plan);
}
function queueSave(action: () => Promise<void>) {
  savesPending++;
  emit("busy", true);
  saves = saves
    .then(async () => {
      await nextTick();
      await action();
    })
    .catch((cause) => {
      error.value = cause instanceof Error ? cause.message : String(cause);
    })
    .finally(() => {
      savesPending--;
      emit("busy", working.value || savesPending > 0);
    });
  return saves;
}
async function savePreparation() {
  await queueSave(async () => {
    if (!preparation.value) return;
    const next = clone(props.plan);
    next.dataPreparation = clone(preparation.value);
    next.dataTargetPaths = [...targetPaths.value];
    next.revision++;
    next.executable = false;
    next.requiresReverify = true;
    await save(next);
  });
}
async function describe() {
  await run(async () => {
    const source = availableSources.value[sourceIndex.value];
    if (!source) return;
    const result = await api.verifyOracleTypeData({ target: props.plan.target, action: "describe", relation: source });
    if (!result.relation) throw new Error("The complete source projection could not be read.");
    const next = clone(props.plan);
    next.dataPreparation = {
      id: uuid(),
      source,
      old: { owner: source.owner, name: "" },
      expected: { owner: source.owner, name: "" },
      target: { ...source },
      fields: result.relation.projection.map((field, index) => ({ sourcePath: field.path, objectNull: field.objectNull, oldColumn: `C${index + 1}`, expectedColumn: `C${index + 1}`, targetPath: [...field.path], targetObjectNull: field.objectNull, unchanged: true })),
    };
    next.dataTargetPaths = undefined;
    next.revision++;
    await save(next);
  });
}
async function register() {
  await run(async () => {
    const value = preparation.value;
    if (!value) return;
    const mapping = clone(value);
    mapping.fields.forEach((field, index) => {
      const path: unknown = JSON.parse(targetPaths.value[index]);
      if (!Array.isArray(path) || !path.length || path.some((part) => typeof part !== "string" || !part)) throw new Error(t("objects.typeDataPathError"));
      field.targetPath = path;
    });
    const next = await registerOracleTypeDataMapping(props.plan, mapping, props.persist);
    emit("update", next);
  });
}
function openPreparationSql() {
  const value = preparation.value;
  if (!value) return;
  const fields = value.fields
    .map((field) => {
      const path = `T.${field.sourcePath.map(quote).join(".")}`;
      return `  ${field.objectNull ? `CASE WHEN ${path} IS NULL THEN 1 ELSE 0 END` : path} AS ${quote(field.oldColumn)}`;
    })
    .join(",\n");
  queryStore.createTab(props.plan.target.connectionId, props.plan.target.database, t("objects.typeDataPrepareSql"), "query", value.source.owner, `SELECT\n${fields}\nFROM ${label(value.source)} T;`, undefined, { forceNew: true });
}
async function saveInsertDraft(id: string) {
  await queueSave(async () => {
    const next = clone(props.plan);
    const record = next.dataMappings.find((record) => record.manifest.mapping.id === id);
    if (!record || !["not-sent", "failed"].includes(record.insertState)) return;
    record.insertDraft = insertDrafts.value[id];
    record.insertSql = "";
    next.executable = false;
    next.requiresReverify = true;
    next.revision++;
    await save(next);
  });
}
async function previewInsert(id: string) {
  await run(async () => emit("update", await prepareOracleTypeDataInsert(props.plan, id, insertDrafts.value[id] ?? "", props.persist)));
}
async function insert(id: string) {
  await run(async () => {
    const record = props.plan.dataMappings.find((record) => record.manifest.mapping.id === id);
    if (!record || insertDrafts.value[id] !== record.insertSql) return;
    await executeWithProductionSqlGuard({
      connection: connectionStore.getConfig(props.plan.target.connectionId),
      database: props.plan.target.database,
      sql: record.insertSql,
      source: t("objects.typeDataTitle"),
      execute: async () => {
        if (!props.isCurrent()) return false;
        await executeOracleTypeDataInsert(props.plan, id, { persist: props.persist, isCurrent: props.isCurrent });
        return true;
      },
    });
    emit("update", clone(props.plan));
  });
}
async function verify() {
  await run(async () => {
    const next = clone(props.plan);
    await verifyOracleTypeDataMappings(next);
    next.revision++;
    next.executable = false;
    next.requiresReverify = true;
    await save(next);
  });
}
</script>

<template>
  <section class="space-y-3 border-t pt-4" aria-labelledby="type-data-title">
    <h3 id="type-data-title" class="text-sm font-semibold">{{ t("objects.typeDataTitle") }}</h3>
    <p class="text-sm leading-relaxed text-muted-foreground">{{ t("objects.typeDataInstructions") }}</p>
    <p v-if="error" role="alert" class="whitespace-pre-wrap break-words text-sm text-destructive">{{ error }}</p>
    <div v-if="availableSources.length && !preparation" class="flex flex-wrap items-center gap-2">
      <select v-model="sourceIndex" :disabled="locked" :aria-label="t('objects.typeDataSource')" class="min-w-0 rounded border bg-background p-2 text-sm">
        <option v-for="(source, index) in availableSources" :key="label(source)" :value="index">{{ label(source) }}</option>
      </select>
      <Button variant="outline" size="sm" :disabled="locked" @click="describe">{{ t("objects.typeDataReadProjection") }}</Button>
    </div>
    <div v-if="preparation" class="space-y-3 rounded border p-3">
      <p class="break-words font-mono text-sm">{{ label(preparation.source) }}</p>
      <div class="grid gap-3 sm:grid-cols-3">
        <fieldset v-for="kind in ['old', 'expected', 'target'] as const" :key="kind" class="space-y-2" :disabled="locked">
          <legend class="mb-1 text-sm font-medium">{{ kind === "old" ? "OLD" : kind === "expected" ? "EXPECTED" : t("objects.typeDataTarget") }}</legend>
          <label class="block space-y-1 text-xs">{{ t("objects.typeDataOwner") }}<Input v-model="preparation[kind].owner" @change="savePreparation" /></label>
          <label class="block space-y-1 text-xs">{{ t("objects.name") }}<Input v-model="preparation[kind].name" @change="savePreparation" /></label>
        </fieldset>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-sm">
          <thead>
            <tr class="border-b">
              <th class="p-2">{{ t("objects.typeDataSource") }}</th>
              <th class="p-2">OLD</th>
              <th class="p-2">EXPECTED</th>
              <th class="p-2">{{ t("objects.typeDataTargetPath") }}</th>
              <th class="p-2">{{ t("objects.typeDataUnchanged") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(field, index) in preparation.fields" :key="index" class="border-b last:border-0">
              <td class="p-2 font-mono text-xs">{{ JSON.stringify(field.sourcePath) }}{{ field.objectNull ? " IS NULL" : "" }}</td>
              <td class="min-w-28 p-2"><Input v-model="field.oldColumn" :disabled="locked" :aria-label="`OLD ${index + 1}`" @change="savePreparation" /></td>
              <td class="min-w-28 p-2"><Input v-model="field.expectedColumn" :disabled="locked" :aria-label="`EXPECTED ${index + 1}`" @change="savePreparation" /></td>
              <td class="min-w-40 space-y-1 p-2">
                <Input v-model="targetPaths[index]" :disabled="locked" :aria-label="`${t('objects.typeDataTargetPath')} ${index + 1}`" @change="savePreparation" /><label class="flex items-center gap-1 font-mono text-xs"
                  ><input v-model="field.targetObjectNull" type="checkbox" :disabled="locked" :aria-label="`${t('objects.typeDataTargetPath')} ${index + 1} IS NULL`" @change="savePreparation" />IS NULL</label
                >
              </td>
              <td class="p-2"><input v-model="field.unchanged" type="checkbox" :disabled="locked" :aria-label="`${t('objects.typeDataUnchanged')} ${index + 1}`" @change="savePreparation" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-sm text-muted-foreground">{{ t("objects.typeDataPrepareHint") }}</p>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" :disabled="locked" @click="openPreparationSql">{{ t("objects.typeDataPrepareSql") }}</Button
        ><Button variant="outline" size="sm" :disabled="locked" @click="register">{{ t("objects.typeDataRegister") }}</Button>
      </div>
    </div>
    <div v-for="record in plan.dataMappings" :key="record.manifest.mapping.id" class="space-y-3 rounded border p-3">
      <p class="break-words text-sm font-medium">{{ label(record.manifest.mapping.source) }} → {{ label(record.manifest.mapping.target) }}</p>
      <p class="break-words font-mono text-xs">OLD {{ label(record.manifest.mapping.old) }} · {{ record.manifest.old.rowCount }}<br />EXPECTED {{ label(record.manifest.mapping.expected) }} · {{ record.manifest.expected.rowCount }}</p>
      <p role="status" class="text-sm">{{ record.manifest.verifiedTarget ? t("objects.typeDataVerified") : t("objects.typeDataWaiting") }}</p>
      <details>
        <summary class="cursor-pointer text-sm text-muted-foreground">{{ t("objects.typeDataIntegrity") }}</summary>
        <pre class="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs">{{
          JSON.stringify({ oldId: record.manifest.old.relation.objectId, old: record.manifest.old.fingerprint, expectedId: record.manifest.expected.relation.objectId, expected: record.manifest.expected.fingerprint }, null, 2)
        }}</pre>
      </details>
      <details v-if="!record.manifest.verifiedTarget" class="space-y-2">
        <summary class="cursor-pointer text-sm">{{ t("objects.typeDataBoundedInsert") }}</summary>
        <p class="text-sm text-muted-foreground">{{ t("objects.typeDataInsertHint") }}</p>
        <textarea
          v-model="insertDrafts[record.manifest.mapping.id]"
          class="min-h-24 w-full resize-y rounded border border-input bg-background p-2 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          spellcheck="false"
          :disabled="locked || !['not-sent', 'failed'].includes(record.insertState)"
          :aria-label="t('objects.typeDataBoundedInsert')"
          @change="saveInsertDraft(record.manifest.mapping.id)"
        />
        <p role="status" class="text-sm">{{ t(`objects.typeManagementState.${record.insertState}`) }}{{ record.message ? ` · ${record.message}` : "" }}</p>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" :disabled="locked || !['not-sent', 'failed'].includes(record.insertState)" @click="previewInsert(record.manifest.mapping.id)">{{ t("objects.typeDataPreviewInsert") }}</Button
          ><Button variant="outline" size="sm" :disabled="locked || record.insertState !== 'not-sent' || !record.insertSql || record.insertSql !== insertDrafts[record.manifest.mapping.id]" @click="insert(record.manifest.mapping.id)">{{ t("objects.typeDataRunInsert") }}</Button>
        </div>
      </details>
    </div>
    <Button v-if="plan.dataMappings.length" variant="outline" size="sm" :disabled="locked" @click="verify">{{ t("objects.typeDataVerify") }}</Button>
    <p v-if="plan.dataMappings.length" class="text-sm text-muted-foreground">{{ t("objects.typeDataKeepBaselines") }}</p>
  </section>
</template>
