<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { parseOracleTriggerDefinition, prepareDisabledOracleTriggerReplacement, updateOracleTriggerDefinition, type OracleTriggerDefinition, type OracleTriggerFields } from "@/lib/table/oracleTriggerDefinition";
import { saveOracleTriggerDefinition } from "@/lib/table/oracleTriggerSave";
import { loadOracleTriggerRecovery, preserveOracleTriggerRecovery, type OracleTriggerRecoveryEntry } from "@/lib/table/oracleTriggerRecovery";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import { invalidateObjectDdl } from "@/lib/metadata/objectDdlCache";

const props = defineProps<{ open: boolean; connectionId: string; database: string; schema: string; name: string; tableSchema: string; tableName: string }>();
const emit = defineEmits<{ "update:open": [boolean]; saved: []; changed: [] }>();
const { t } = useI18n();
const connections = useConnectionStore();
const source = ref("");
const original = ref("");
const definition = ref<OracleTriggerDefinition>();
const fields = ref<OracleTriggerFields>();
const mode = ref<"source" | "structured">("source");
const busy = ref(false);
const loading = ref(false);
const error = ref("");
const preview = ref("");
const recovery = ref<OracleTriggerRecoveryEntry[]>([]);
const recoveryId = ref("");
const selectedRecovery = computed(() => recovery.value.find((entry) => entry.id === recoveryId.value) ?? recovery.value.at(-1));
const recoveryOpen = ref(false);
let loadEpoch = 0;

const currentSource = computed(() => mode.value === "structured" && definition.value && fields.value ? updateOracleTriggerDefinition(definition.value, fields.value) : source.value);

watch(() => [props.open, props.name, props.schema, props.connectionId, props.database, props.tableSchema, props.tableName], async () => {
  const epoch = ++loadEpoch;
  if (!props.open) return;
  const scope = { connectionId: props.connectionId, database: props.database, schema: props.schema, name: props.name };
  loading.value = true;
  error.value = "";
  preview.value = "";
  definition.value = undefined;
  fields.value = undefined;
  source.value = "";
  original.value = "";
  recovery.value = [];
  recoveryId.value = "";
  recoveryOpen.value = false;
  mode.value = "source";
  try {
    const history = await loadOracleTriggerRecovery(scope);
    if (epoch !== loadEpoch) return;
    recovery.value = history;
    recoveryId.value = history.at(-1)?.id ?? "";
    const result = await api.getObjectSource(scope.connectionId, scope.database, scope.schema, scope.name, "TRIGGER");
    if (epoch !== loadEpoch) return;
    source.value = result.source;
    original.value = result.source;
    definition.value = parseOracleTriggerDefinition(result.source);
    fields.value = definition.value.fields && { ...definition.value.fields };
    if (definition.value.structured) mode.value = "structured";
  } catch (e) { if (epoch === loadEpoch) error.value = e instanceof Error ? e.message : String(e); }
  finally { if (epoch === loadEpoch) loading.value = false; }
}, { immediate: true });

function switchMode(next: "source" | "structured") {
  if (next === mode.value) return;
  try {
    if (next === "source") source.value = currentSource.value;
    else {
      const parsed = parseOracleTriggerDefinition(source.value);
      if (!parsed.structured) throw new Error(parsed.reason);
      definition.value = parsed;
      fields.value = { ...parsed.fields! };
    }
    mode.value = next;
    preview.value = "";
    error.value = "";
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
}

function showPreview() {
  try { preview.value = prepareDisabledOracleTriggerReplacement(currentSource.value, props); error.value = ""; }
  catch (e) { preview.value = ""; error.value = e instanceof Error ? e.message : String(e); }
}

async function save() {
  if (busy.value || loading.value || !original.value) return;
  busy.value = true;
  error.value = "";
  let mutationStarted = false;
  const scope = { connectionId: props.connectionId, database: props.database, schema: props.schema, name: props.name, tableSchema: props.tableSchema, tableName: props.tableName };
  const originalSource = original.value;
  const saveEpoch = loadEpoch;
  try {
    const candidate = currentSource.value;
    const sql = prepareDisabledOracleTriggerReplacement(candidate, scope);
    if (preview.value !== sql) { preview.value = sql; return; }
    const executed = await executeWithProductionSqlGuard({
      connection: connections.getConfig(scope.connectionId), database: scope.database, sql,
      source: t("structureEditor.editTriggerDefinition"),
      execute: async () => {
        if (saveEpoch !== loadEpoch) return false;
        await saveOracleTriggerDefinition({
          ...scope, source: candidate, originalSource,
          execute: (statement) => api.executeQuery(scope.connectionId, scope.database, statement, scope.schema),
          readSource: async () => (await api.getObjectSource(scope.connectionId, scope.database, scope.schema, scope.name, "TRIGGER")).source,
          preserveOriginal: async (text, enabled) => {
            const entry = await preserveOracleTriggerRecovery(scope, text, enabled);
            if (saveEpoch === loadEpoch) {
              recovery.value = [...recovery.value, entry];
              recoveryId.value = entry.id;
            }
          },
          onMutationStarted: () => { mutationStarted = true; },
        });
        return true;
      },
    });
    if (!executed || saveEpoch !== loadEpoch) return;
    emit("saved");
    emit("update:open", false);
  } catch (e) { if (saveEpoch === loadEpoch) error.value = e instanceof Error ? e.message : String(e); }
  finally {
    if (mutationStarted) {
      await Promise.allSettled([
        invalidateObjectMetadataCache({ connectionId: scope.connectionId, database: scope.database, schema: scope.tableSchema, tableName: scope.tableName }),
        invalidateObjectDdl({ connectionId: scope.connectionId, database: scope.database, schema: scope.tableSchema, tableName: scope.tableName }),
        invalidateObjectDdl({ connectionId: scope.connectionId, database: scope.database, schema: scope.schema, tableName: scope.name }),
      ]);
      emit("changed");
    }
    busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(value) => { if (!busy) emit('update:open', value); }">
    <DialogContent class="max-w-3xl">
      <DialogHeader><DialogTitle>{{ t("structureEditor.editTriggerDefinition") }} — {{ schema }}.{{ name }}</DialogTitle></DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t("structureEditor.triggerReplacementWarning") }}</p>
      <div class="flex gap-2">
        <Button variant="outline" :disabled="busy || loading" @click="switchMode('structured')">{{ t("structureEditor.triggerStructuredMode") }}</Button>
        <Button variant="outline" :disabled="busy || loading" @click="switchMode('source')">{{ t("structureEditor.triggerSourceMode") }}</Button>
      </div>
      <p v-if="definition?.reason" class="text-sm text-muted-foreground">{{ definition.reason }}</p>
      <div v-if="mode === 'structured' && fields" class="grid gap-3">
        <div class="grid grid-cols-2 gap-3">
          <label>{{ t("structureEditor.triggerTiming") }}<Input v-model="fields.timing" :disabled="busy" /></label>
          <label>{{ t("structureEditor.triggerEvent") }}<Input v-model="fields.events" :disabled="busy" /></label>
        </div>
        <label>REFERENCING<Input v-model="fields.referencing" :disabled="busy" /></label>
        <label class="flex items-center gap-2"><input v-model="fields.rowLevel" type="checkbox" :disabled="busy" />FOR EACH ROW</label>
        <label>WHEN<textarea v-model="fields.when" class="w-full rounded border bg-background p-2 font-mono text-sm" :disabled="busy" /></label>
        <label>{{ t("structureEditor.triggerStatement") }}<textarea v-model="fields.body" class="h-48 w-full rounded border bg-background p-2 font-mono text-sm" :disabled="busy" /></label>
      </div>
      <textarea v-else v-model="source" class="h-72 w-full rounded border bg-background p-2 font-mono text-sm" :disabled="busy || loading" />
      <pre v-if="preview" class="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">{{ preview }}</pre>
      <p v-if="error" class="whitespace-pre-wrap text-sm text-destructive">{{ error }}</p>
      <DialogFooter>
        <Button v-if="recovery.length" variant="outline" @click="recoveryOpen = true">{{ t("structureEditor.triggerOriginalDefinition") }}</Button>
        <Button variant="outline" :disabled="busy || loading" @click="showPreview">{{ t("structureEditor.triggerPreviewDefinition") }}</Button>
        <Button :disabled="busy || loading || !preview" @click="save">{{ t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  <Dialog v-model:open="recoveryOpen">
    <DialogContent class="max-w-3xl"><DialogHeader><DialogTitle>{{ t("structureEditor.triggerOriginalDefinition") }}</DialogTitle></DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t("structureEditor.triggerRecoveryWarning") }}</p>
      <p class="break-all font-mono text-sm">{{ schema }}.{{ name }} → {{ selectedRecovery?.tableSchema && selectedRecovery?.tableName ? `${selectedRecovery.tableSchema}.${selectedRecovery.tableName}` : t("structureEditor.triggerRecoveryTargetUnknown") }}</p>
      <select v-model="recoveryId" class="rounded border bg-background p-2"><option v-for="entry in recovery" :key="entry.id" :value="entry.id">{{ entry.savedAt }} — {{ entry.enabled ? 'ENABLED' : 'DISABLED' }}</option></select>
      <textarea :value="selectedRecovery?.source || ''" readonly class="h-80 w-full rounded border bg-background p-2 font-mono text-sm" />
    </DialogContent>
  </Dialog>
</template>
