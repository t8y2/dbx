<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { usePlDebugStore } from "@/stores/plDebugStore";
import { useQueryStore } from "@/stores/queryStore";
import { oracleInvalidObjectSourceKind } from "@/lib/database/oracleInvalidObjects";
import type { PlDebugInspectResult } from "@/lib/debug/plDebugProtocol";
import type { PlDebugLaunchTarget } from "./plDebugLaunch";

const props = defineProps<{ target: PlDebugLaunchTarget; open: boolean; preparing?: boolean }>();
const emit = defineEmits<{ compiled: []; edit: [] }>();
const { t } = useI18n();
const store = usePlDebugStore();
const query = useQueryStore();
const inspected = ref<PlDebugInspectResult | null>(null);
const loading = ref(false);
const confirmed = ref(false);
const message = ref<string | null>(null);
const preview = computed(() => inspected.value?.compilePreview);
const observation = computed(() => inspected.value?.compileObservation);
const original = computed(() => (store.compilationRef?.connectionId === props.target.connectionId ? store.compilationReceipt : null));
const pending = computed(() => store.compilationRef?.connectionId === props.target.connectionId && store.compilationUnresolved);
const readback = computed(() => original.value?.result?.readback as Record<string, unknown> | undefined);
const diagnostics = computed(() => (Array.isArray(readback.value?.diagnostics) ? readback.value.diagnostics : []) as Array<Record<string, unknown>>);
const operationErrors = computed(() =>
  [original.value?.error, original.value?.cleanupError, ...["error", "ddlError", "resourceError", "cleanupError", "statementCloseError"].map((key) => original.value?.result?.[key])].filter((value): value is string => typeof value === "string" && value.length > 0),
);
const fingerprint = () => JSON.stringify(props.target);
let serial = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let refreshedOperation: string | null = null;

function stopPolling() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

async function readOriginal() {
  stopPolling();
  if (!props.open || props.preparing || store.compilationBusy || store.compilationRef?.connectionId !== props.target.connectionId) return;
  const context = fingerprint();
  const token = serial;
  try {
    const receipt = await store.recoverCompilation();
    if (!props.open || context !== fingerprint() || token !== serial) return;
    message.value = null;
    const sameUnit = receipt?.target?.schema === (preview.value?.schema ?? props.target.schema) && receipt?.target?.objectName === (props.target.packageName || props.target.objectName) && receipt?.target?.objectType === (props.target.packageName ? "PACKAGE BODY" : props.target.objectType);
    if (sameUnit && receipt?.finished && receipt.ddlState === "executed" && receipt.releaseState === "released" && refreshedOperation !== receipt.operationId) {
      refreshedOperation = receipt.operationId;
      inspected.value = null;
      confirmed.value = false;
      await loadPreview();
      if (props.open && context === fingerprint()) emit("compiled");
    }
    if (props.open && receipt && !receipt.finished) timer = setTimeout(() => void readOriginal(), 1000);
  } catch (caught) {
    if (props.open && context === fingerprint() && token === serial) message.value = String(caught);
  }
}

watch(
  () => [props.open, props.preparing, store.compilationRef?.operationId, store.compilationBusy],
  () => {
    if (pending.value && props.open && !props.preparing && !store.compilationBusy) void readOriginal();
    else stopPolling();
  },
  { immediate: true },
);
watch(
  () => props.target,
  () => {
    serial += 1;
    inspected.value = null;
    confirmed.value = false;
    loading.value = false;
    message.value = null;
    stopPolling();
  },
  { deep: true },
);
onScopeDispose(() => {
  serial += 1;
  stopPolling();
});

async function loadPreview() {
  const token = ++serial;
  const target = { ...props.target };
  const objectType = target.objectType;
  if (objectType !== "PROCEDURE" && objectType !== "FUNCTION") return;
  loading.value = true;
  confirmed.value = false;
  inspected.value = null;
  message.value = null;
  try {
    const value = await store.inspectTarget(target.connectionId, target.database, { schema: target.schema, objectType, objectName: target.objectName, packageName: target.packageName, metadataPreparation: "debug_compile" });
    if (token === serial) inspected.value = value;
  } catch (caught) {
    if (token === serial) message.value = String(caught);
  } finally {
    if (token === serial) loading.value = false;
  }
}

async function compile() {
  const current = inspected.value;
  const target = { ...props.target };
  const objectType = target.objectType;
  if (objectType !== "PROCEDURE" && objectType !== "FUNCTION") return;
  if (!confirmed.value || !current?.compilePreview?.canCompile || loading.value || store.compilationBusy || store.compilationUnresolved) return;
  const signature = fingerprint();
  const token = serial;
  message.value = null;
  try {
    await store.compileDebug(
      {
        connectionId: target.connectionId,
        database: target.database,
        target: { schema: target.schema, objectType, objectName: target.objectName, packageName: target.packageName, metadataPreparation: "debug_compile" },
        preview: current.compilePreview,
        expectedConnectionRevision: current.connectionRevision,
        confirmed: true,
      },
      () => props.open && confirmed.value && inspected.value === current && fingerprint() === signature,
    );
    if (props.open && token === serial && fingerprint() === signature) {
      confirmed.value = false;
      await readOriginal();
    }
  } catch (caught) {
    if (props.open && token === serial && fingerprint() === signature) message.value = String(caught);
  }
}

function editSource() {
  const target = props.target;
  const owner = preview.value?.schema ?? target.schema;
  const objectType = oracleInvalidObjectSourceKind(target.packageName ? "PACKAGE BODY" : target.objectType);
  if (!owner || !objectType) return;
  const name = target.packageName ?? target.objectName;
  query.openObjectSourceTabPending({ connectionId: target.connectionId, database: target.database, title: `Source - ${name}`, schema: owner, initialEditing: true, request: { name, objectType } });
  emit("edit");
}
</script>

<template>
  <section class="space-y-2 border-t pt-3 text-sm" :aria-label="t('plDebug.compile.title')">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <span>{{ t("plDebug.compile.title") }}: {{ t(`plDebug.compile.${preview?.settings?.state ?? "unknown"}`) }}</span>
      <Button variant="outline" size="sm" :disabled="preparing || loading || store.compilationBusy || store.compilationUnresolved" @click="loadPreview">{{ loading ? t("plDebug.launch.loading") : t("plDebug.compile.preview") }}</Button>
      <Button variant="outline" size="sm" :disabled="store.compilationBusy || !(preview?.schema ?? target.schema)" @click="editSource">{{ t("plDebug.compile.editSource") }}</Button>
    </div>
    <div v-if="preview" class="space-y-2">
      <p class="break-all font-mono">{{ preview.schema }}.{{ preview.objectName }} — {{ preview.objectType }}</p>
      <pre class="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/30 p-2 font-mono text-sm">{{ preview.sql }}</pre>
      <p>{{ t("plDebug.compile.ddlImpact") }}</p>
      <p v-if="preview.objectType === 'PACKAGE BODY'">{{ t("plDebug.compile.packageImpact") }}</p>
      <p v-if="!preview.reusesSettings">{{ t("plDebug.compile.settingsImpact") }}</p>
      <p v-if="!preview.canCompile" role="alert" class="text-destructive">{{ t("plDebug.compile.sourceUnavailable") }}</p>
      <label class="flex items-start gap-2"
        ><input v-model="confirmed" type="checkbox" class="mt-1" :disabled="!preview.canCompile || store.compilationBusy || store.compilationUnresolved" /><span>{{ t("plDebug.compile.confirmImpact") }}</span></label
      >
      <div class="flex flex-wrap gap-2">
        <Button size="sm" :disabled="!confirmed || !preview.canCompile || store.compilationBusy || store.compilationUnresolved" @click="compile">{{ t("plDebug.compile.execute") }}</Button>
      </div>
    </div>
    <div v-if="observation" class="space-y-1" role="status">
      <p>
        {{ t("plDebug.compile.currentObservation") }}: <span class="break-all font-mono">{{ observation.schema }}.{{ observation.objectName }} — {{ observation.objectType }}</span
        ><span v-if="observation.readback?.status"> — {{ observation.readback.status }}</span>
      </p>
      <p v-if="observation.error || observation.readback?.diagnosticsError || observation.readback?.settingsError" class="break-words text-destructive">{{ observation.error ?? observation.readback?.diagnosticsError ?? observation.readback?.settingsError }}</p>
      <p v-if="observation.readback?.diagnosticsComplete === false" class="text-destructive">{{ t("plDebug.results.partial") }}</p>
      <ul v-if="observation.readback?.diagnostics?.length" class="max-h-36 overflow-auto font-mono">
        <li v-for="(item, index) in observation.readback.diagnostics" :key="index">{{ item.line }}:{{ item.position }} {{ item.text }}</li>
      </ul>
    </div>
    <div v-if="original || pending" class="space-y-1" role="status">
      <p>
        {{ t("plDebug.compile.originalResult") }}: <span v-if="original?.target" class="break-all font-mono">{{ original.target.schema }}.{{ original.target.objectName }} — {{ original.target.objectType }} — </span
        ><span v-else-if="original" class="break-all font-mono">{{ original.operationId }} — </span>{{ original ? t(`plDebug.compile.${original.finished ? original.ddlState : "pending"}`) : t("plDebug.compile.unknown") }}<span v-if="readback?.status"> — {{ readback.status }}</span>
      </p>
      <p v-if="original?.releaseState !== 'released'">{{ t("plDebug.compile.releasePending") }}</p>
      <p v-if="original?.ddlState === 'executed'">{{ t("plDebug.compile.noAutoStart") }}</p>
      <p v-if="readback?.diagnosticsComplete === false || original?.result?.readbackError" class="text-destructive">{{ t("plDebug.compile.readbackIncomplete") }} {{ readback?.diagnosticsError ?? original?.result?.readbackError }}</p>
      <ul v-if="diagnostics.length" class="max-h-36 overflow-auto font-mono">
        <li v-for="(item, index) in diagnostics" :key="index">{{ item.line }}:{{ item.position }} {{ item.text }}</li>
      </ul>
      <p v-for="(error, index) in operationErrors" :key="index" class="break-words text-destructive">{{ error }}</p>
      <Button v-if="pending" size="sm" variant="outline" @click="readOriginal">{{ t("plDebug.compile.readOriginal") }}</Button>
    </div>
    <p v-if="message" role="alert" class="break-words text-destructive">{{ message }}</p>
  </section>
</template>
