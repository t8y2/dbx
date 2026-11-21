<script setup lang="ts">
import { uuid } from "@/lib/common/utils";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/backend/api";
import { BackendErrorException, normalizeBackendError } from "@/lib/backend/errorUtils";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import {
  buildPostgresSequenceAlterSql,
  buildPostgresSequenceMetadataSql,
  buildPostgresSequenceStateSql,
  buildPostgresSequenceVersionSql,
  parsePostgresSequenceMetadata,
  parsePostgresSequenceState,
  parsePostgresSequenceVersion,
  PostgresSequenceValidationError,
  type PostgresSequenceDraft,
  type PostgresSequenceMetadata,
} from "@/lib/database/postgresSequence";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";

const props = defineProps<{ open: boolean; connectionId: string; database: string; schema: string; name: string }>();
const emit = defineEmits<{ "update:open": [open: boolean]; saved: [] }>();
const { t } = useI18n();
const connectionStore = useConnectionStore();
const safetyStore = useProductionSafetyStore();
const scopeId = `postgres-sequence-${uuid()}`;
const metadata = shallowRef<PostgresSequenceMetadata>();
const state = shallowRef<ReturnType<typeof parsePostgresSequenceState>>();
const draft = ref<PostgresSequenceDraft>();
const restartEnabled = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const stateError = ref("");
const saved = ref(false);
const needsRefresh = ref(false);
let revision = 0;
const fields = ["startValue", "minValue", "maxValue", "increment", "cacheSize"] as const;
const connection = computed(() => connectionStore.connections.find((item) => item.id === props.connectionId));
const targetKey = computed(() => JSON.stringify([props.open, props.connectionId, connection.value?.db_type, props.database, props.schema, props.name]));
const editable = computed(() => metadata.value?.canAlter && !loading.value && !saving.value && !needsRefresh.value);

function message(reason: unknown) {
  return reason instanceof PostgresSequenceValidationError ? t(`postgresSequence.errors.${reason.code}`) : reason instanceof Error ? reason.message : String(reason);
}
function newDraft(value: PostgresSequenceMetadata): PostgresSequenceDraft {
  return { startValue: value.startValue, minValue: value.minValue, maxValue: value.maxValue, increment: value.increment, cacheSize: value.cacheSize, cycle: value.cycle, restartWith: "" };
}
const dirty = computed(() => !!metadata.value && !!draft.value && (restartEnabled.value || JSON.stringify({ ...draft.value, restartWith: "" }) !== JSON.stringify(newDraft(metadata.value))));
const preview = computed(() => {
  if (!metadata.value || !draft.value) return { sql: "", error: "" };
  try {
    if (restartEnabled.value && !draft.value.restartWith.trim()) return { sql: "", error: t("postgresSequence.errors.invalidRestartValue") };
    return { sql: buildPostgresSequenceAlterSql(metadata.value, metadata.value, { ...draft.value, restartWith: restartEnabled.value ? draft.value.restartWith : "" }) ?? "", error: "" };
  } catch (reason) {
    return { sql: "", error: message(reason) };
  }
});
type Target = { connectionId: string; database: string; schema: string; name: string };
function currentTarget(): Target {
  return { connectionId: props.connectionId, database: props.database, schema: props.schema, name: props.name };
}
async function query(target: Target, sql: string) {
  const result = await api.executeQuery(target.connectionId, target.database, sql, undefined, undefined, { maxRows: 2 });
  if (result.execution_error) throw new BackendErrorException(result.error ?? t("postgresSequence.queryFailed"));
  return result;
}
function isCurrent(serial: number, key: string) {
  return serial === revision && props.open && targetKey.value === key;
}
async function load() {
  const serial = ++revision;
  const key = targetKey.value;
  const target = currentTarget();
  safetyStore.cancelScope(scopeId);
  loading.value = true;
  metadata.value = undefined;
  draft.value = undefined;
  state.value = undefined;
  restartEnabled.value = false;
  error.value = "";
  stateError.value = "";
  needsRefresh.value = false;
  try {
    if (connection.value?.db_type !== "postgres") throw new Error(t("postgresSequence.postgresOnly"));
    await connectionStore.ensureConnected(target.connectionId);
    if (!isCurrent(serial, key)) return;
    parsePostgresSequenceVersion(await query(target, buildPostgresSequenceVersionSql()));
    if (!isCurrent(serial, key)) return;
    const loaded = parsePostgresSequenceMetadata(await query(target, buildPostgresSequenceMetadataSql(target)));
    if (!isCurrent(serial, key)) return;
    metadata.value = loaded;
    draft.value = newDraft(loaded);
    if (loaded.canReadState) {
      try {
        const loadedState = parsePostgresSequenceState(await query(target, buildPostgresSequenceStateSql(target)));
        if (isCurrent(serial, key)) state.value = loadedState;
      } catch (reason) {
        if (isCurrent(serial, key)) stateError.value = message(reason);
      }
    }
  } catch (reason) {
    if (isCurrent(serial, key)) error.value = message(reason);
  } finally {
    if (isCurrent(serial, key)) loading.value = false;
  }
}
async function refresh() {
  if (loading.value || saving.value || (dirty.value && !window.confirm(t("postgresSequence.discardChanges")))) return;
  saved.value = false;
  await load();
}
async function save() {
  const baseline = metadata.value;
  const sql = preview.value.sql;
  if (!editable.value || !baseline || !sql || preview.value.error) return;
  const serial = revision;
  const key = targetKey.value;
  const target = currentTarget();
  saving.value = true;
  error.value = "";
  saved.value = false;
  let mutationIssued = false;
  try {
    const applied = await executeWithProductionSqlGuard({
      connection: connection.value,
      database: target.database,
      sql,
      source: t("postgresSequence.title"),
      scopeId,
      execute: async () => {
        if (!isCurrent(serial, key)) return false;
        await connectionStore.ensureConnected(target.connectionId);
        if (!isCurrent(serial, key)) return false;
        // Compare definition, not last_value: ordinary nextval calls must not
        // invalidate an edit. A recreated sequence or changed definition must.
        const latest = parsePostgresSequenceMetadata(await query(target, buildPostgresSequenceMetadataSql(target)));
        if (!isCurrent(serial, key)) return false;
        if (latest.oid !== baseline.oid || latest.dataType !== baseline.dataType || JSON.stringify(newDraft(latest)) !== JSON.stringify(newDraft(baseline))) throw new Error(t("postgresSequence.conflict"));
        mutationIssued = true;
        await query(target, sql);
        connectionStore.invalidateMetadataCache(target.connectionId, target.database, target.schema);
        return true;
      },
    });
    if (applied) {
      if (!isCurrent(serial, key)) return;
      emit("saved");
      saved.value = true;
      // Clear the applied draft before reloading. A failed reload must never
      // leave RESTART available to be executed a second time accidentally.
      draft.value = undefined;
      metadata.value = undefined;
      restartEnabled.value = false;
      saving.value = false;
      await load();
    }
  } catch (reason) {
    if (isCurrent(serial, key)) {
      error.value = message(reason);
      // A lost response does not prove ALTER failed. Do not offer a replay of
      // RESTART until the user has reread the server's actual state.
      needsRefresh.value = mutationIssued && normalizeBackendError(reason)?.operationOutcome !== "not_started";
    }
  } finally {
    if (isCurrent(serial, key)) saving.value = false;
  }
}
function close(open: boolean) {
  if (open || saving.value || (dirty.value && !window.confirm(t("postgresSequence.discardChanges")))) return;
  safetyStore.cancelScope(scopeId);
  emit("update:open", false);
}
watch(
  targetKey,
  () => {
    ++revision;
    safetyStore.cancelScope(scopeId);
    saving.value = false;
    saved.value = false;
    if (props.open) void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++revision;
  safetyStore.cancelScope(scopeId);
});
</script>

<template>
  <Dialog :open="open" @update:open="close">
    <DialogContent class="sm:max-w-2xl" :show-close-button="!saving" @interact-outside.prevent>
      <DialogHeader
        ><DialogTitle>{{ t("postgresSequence.title") }} · {{ schema }}.{{ name }}</DialogTitle></DialogHeader
      >
      <div class="min-h-0 space-y-4 overflow-auto">
        <p v-if="saved" role="status" class="text-sm text-green-600 dark:text-green-400">{{ t("postgresSequence.saved") }}</p>
        <p v-if="error" role="alert" class="break-words text-sm text-destructive">{{ error }}</p>
        <p v-if="needsRefresh" role="status" class="text-sm text-muted-foreground">{{ t("postgresSequence.refreshAfterError") }}</p>
        <p v-if="loading" role="status" class="text-sm text-muted-foreground">{{ t("common.loading") }}</p>
        <template v-if="metadata && draft">
          <dl class="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm">
            <dt class="text-muted-foreground">{{ t("postgresSequence.dataType") }}</dt>
            <dd>{{ metadata.dataType }}</dd>
            <dt class="text-muted-foreground">{{ t("postgresSequence.lastValue") }}</dt>
            <dd class="break-all font-mono">{{ state?.lastValue ?? "—" }}</dd>
            <dt class="text-muted-foreground">{{ t("postgresSequence.isCalled") }}</dt>
            <dd>{{ state ? t(state.isCalled ? "postgresSequence.yes" : "postgresSequence.no") : "—" }}</dd>
          </dl>
          <p class="text-xs text-muted-foreground">{{ t("postgresSequence.stateHint") }}</p>
          <p v-if="!loading && !state" role="status" class="text-xs text-muted-foreground">{{ t("postgresSequence.stateUnavailable") }} {{ stateError }}</p>
          <p v-if="!metadata.canAlter" class="text-sm text-muted-foreground">{{ t("postgresSequence.ownerRequired") }}</p>
          <fieldset :disabled="!editable" class="grid grid-cols-2 gap-3 disabled:opacity-70">
            <label v-for="field in fields" :key="field" class="space-y-1 text-sm">
              <span>{{ t(`postgresSequence.${field}`) }}</span>
              <Input v-model="draft[field]" :data-testid="`sequence-${field}`" type="text" :aria-label="t(`postgresSequence.${field}`)" />
            </label>
            <label class="flex items-center gap-2 self-end py-2 text-sm"><input v-model="draft.cycle" data-testid="sequence-cycle" type="checkbox" />{{ t("postgresSequence.cycle") }}</label>
            <p class="col-span-2 text-xs text-muted-foreground">{{ t("postgresSequence.startHint") }}</p>
            <label class="col-span-2 flex items-center gap-2 border-t pt-3 text-sm"><input v-model="restartEnabled" data-testid="sequence-restart-enabled" type="checkbox" />{{ t("postgresSequence.restart") }}</label>
            <Input v-if="restartEnabled" v-model="draft.restartWith" data-testid="sequence-restartWith" type="text" :aria-label="t('postgresSequence.restart')" class="col-span-2" />
            <p v-if="restartEnabled" class="col-span-2 text-xs text-muted-foreground">{{ t("postgresSequence.restartHint") }}</p>
          </fieldset>
          <p v-if="preview.error" role="alert" class="text-sm text-destructive">{{ preview.error }}</p>
          <div v-if="preview.sql" class="space-y-1">
            <p class="text-xs text-muted-foreground">{{ t("postgresSequence.sqlPreview") }}</p>
            <pre data-testid="sequence-sql-preview" class="overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{{ preview.sql }}</pre>
          </div>
        </template>
      </div>
      <DialogFooter>
        <Button variant="outline" data-testid="sequence-refresh" :disabled="loading || saving" @click="refresh">{{ t("common.refresh") }}</Button>
        <Button variant="outline" :disabled="saving" @click="close(false)">{{ t("common.close") }}</Button>
        <Button data-testid="sequence-save" :disabled="!editable || !preview.sql || !!preview.error" @click="save">{{ t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
