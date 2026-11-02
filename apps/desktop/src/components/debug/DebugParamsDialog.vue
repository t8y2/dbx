<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { usePlDebugStore } from "@/stores/plDebugStore";
import type { PlDebugParam, PlDebugStartRequest } from "@/lib/backend/pl-debug-tauri";
import type { PlDebugArgument, PlDebugInspectResult } from "@/lib/debug/plDebugProtocol";
import { canonicalPlDebugScalarType, compositeArgumentShape, compositeInputComplete, compositeNode, emptyCompositeValue, type CompositeRoot, type CompositeValue } from "@/lib/debug/plDebugComposite";
import PlDebugCompositeEditor from "./PlDebugCompositeEditor.vue";

const { t } = useI18n();
const store = usePlDebugStore();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  /** PROCEDURE | FUNCTION | ANONYMOUS */
  objectType: string;
  objectName?: string;
  packageName?: string;
  source?: string;
  schema?: string;
  preview: PlDebugInspectResult | null;
  /** True while the caller is still resolving `params` from database metadata. */
  loading?: boolean;
  /** Metadata lookup failure, reported instead of the empty-parameter hint. */
  loadError?: string | null;
  database: string;
  connectionId: string;
  allowTypePreparation?: boolean;
}>();

const emit = defineEmits<{ started: [debugId: string]; refresh: []; recover: []; prepareTypes: [] }>();

const selectedIndex = ref("");
const drafts = ref<PlDebugParam[][]>([]);
const candidates = computed(() => props.preview?.targetPreview?.candidates ?? []);
const selected = computed(() => (selectedIndex.value === "" ? undefined : candidates.value[Number(selectedIndex.value)]));
const editableParams = computed(() => (selectedIndex.value === "" ? [] : (drafts.value[Number(selectedIndex.value)] ?? [])));
const anonymous = computed(() => props.objectType === "ANONYMOUS");
const riskAccepted = ref(false);
const starting = ref(false);
const errorMessage = ref<string | null>(null);
let previousCandidates: typeof candidates.value = [];
const signatureKey = (candidate: (typeof candidates.value)[number]) => {
  const signature = candidate.signature;
  return JSON.stringify([signature.schema, signature.packageName, signature.objectName, signature.objectId, signature.subprogramId, signature.objectType, signature.arguments]);
};

function parameterDraft(param: PlDebugArgument, signature: (typeof candidates.value)[number]["signature"]): PlDebugParam {
  const draft: PlDebugParam = { name: param.name ?? "", mode: param.mode, type: param.type, value: param.type === "PL/SQL BOOLEAN" ? "false" : "", ...(param.mode === "OUT" ? {} : { inputState: param.defaulted === "Y" ? "default" : "value" }) };
  if (param.mode !== "OUT") {
    const shape = compositeArgumentShape(signature, param);
    if (shape && compositeNode(signature, shape)) {
      draft.value = null;
      draft.typedValue = emptyCompositeValue(signature, shape) as CompositeRoot;
    }
    if (canonicalPlDebugScalarType(param.type) === "TIMESTAMP WITH TIME ZONE") draft.typedValue = { kind: "timestamp_tz", value: { local: "", offset: "+00:00", region: null } };
    if (canonicalPlDebugScalarType(param.type) === "TIMESTAMP WITH LOCAL TIME ZONE") draft.typedValue = { kind: "timestamp_ltz", value: { instant: "" } };
  }
  return draft;
}

const shapeFor = (index: number) => compositeArgumentShape(selected.value?.signature, selected.value?.parameters[index]);
function argumentType(signature: (typeof candidates.value)[number]["signature"], argument: PlDebugArgument) {
  const reference = compositeArgumentShape(signature, argument)?.reference;
  return reference ? [reference.owner, reference.packageName, reference.typeName].filter(Boolean).join(".") : argument.type;
}
function compositeComplete(param: PlDebugParam, index: number) {
  if (param.mode !== "OUT" && param.inputState === "value") {
    if (param.type === "BINARY_FLOAT") return /^[0-9a-fA-F]{8}$/.test(param.value ?? "");
    if (param.type === "BINARY_DOUBLE") return /^[0-9a-fA-F]{16}$/.test(param.value ?? "");
  }
  const shape = shapeFor(index);
  return (
    !shape ||
    param.mode === "OUT" ||
    param.inputState === "default" ||
    (!!selected.value && !!param.typedValue && (param.typedValue.kind === "record" || param.typedValue.kind === "collection" || param.typedValue.kind === "object") && compositeInputComplete(selected.value.signature, shape, param.typedValue))
  );
}
function updateCompositeParam(param: PlDebugParam, value: CompositeValue) {
  if (value.kind === "record" || value.kind === "collection" || value.kind === "object") param.typedValue = value;
}

function updateTimezoneParam(param: PlDebugParam, field: "local" | "offset" | "region" | "instant", value: string | number) {
  const typed = param.typedValue;
  if (typed?.kind === "timestamp_tz" && field !== "instant") {
    if (field === "region") typed.value.region = String(value) || null;
    else typed.value[field] = String(value);
  }
  if (typed?.kind === "timestamp_ltz" && field === "instant") typed.value.instant = String(value);
}

watch(
  () => props.preview,
  () => {
    riskAccepted.value = false;
    errorMessage.value = null;
    if (!props.preview) return;
    const previousSelection = selectedIndex.value === "" ? undefined : previousCandidates[Number(selectedIndex.value)];
    const previousDrafts = new Map(previousCandidates.map((candidate, index) => [signatureKey(candidate), drafts.value[index]]));
    const selected = previousSelection ? candidates.value.findIndex((candidate) => signatureKey(candidate) === signatureKey(previousSelection)) : -1;
    drafts.value = candidates.value.map((candidate) => {
      const previous = previousDrafts.get(signatureKey(candidate));
      return candidate.parameters.map((argument, index) => {
        const initial = parameterDraft(argument, candidate.signature);
        const saved = previous?.[index];
        if (!saved) return initial;
        const draft = JSON.parse(JSON.stringify(saved)) as PlDebugParam;
        if (candidate.signature.signatureVersion === 2 && !draft.typedValue && (initial.typedValue?.kind === "record" || initial.typedValue?.kind === "collection" || initial.typedValue?.kind === "object")) return { ...draft, value: null, typedValue: initial.typedValue };
        return draft;
      });
    });
    previousCandidates = candidates.value;
    selectedIndex.value = selected >= 0 ? String(selected) : candidates.value.length === 1 ? "0" : "";
  },
  { immediate: true },
);
watch(selectedIndex, () => {
  riskAccepted.value = false;
});

const title = computed(() => {
  const target = anonymous.value ? t("plDebug.launch.anonymousTitle") : props.packageName ? `${props.packageName}.${props.objectName}` : (props.objectName ?? "");
  return `${t("plDebug.start.title")} — ${target}`;
});

const startRequest = computed<PlDebugStartRequest>(() => ({
  schema: props.schema ?? null,
  objectType: props.objectType,
  objectName: props.objectName ?? null,
  packageName: props.packageName ?? null,
  source: props.source ?? null,
  ...(anonymous.value
    ? {}
    : {
        targetSignature: selected.value?.signature,
        ...(selected.value?.signature.signatureVersion === 2 ? { metadataPreparation: "type_only" as const } : {}),
        params: editableParams.value.map((param) => {
          if (param.mode === "OUT" || param.inputState !== "value") {
            const value = { ...param, value: null };
            delete value.typedValue;
            return value;
          }
          if (selected.value?.signature.signatureVersion === 2) {
            if (param.typedValue?.kind === "record" || param.typedValue?.kind === "collection" || param.typedValue?.kind === "object") return { ...param, value: null };
            if (param.type === "PL/SQL BOOLEAN") return { ...param, value: null, typedValue: { kind: "boolean" as const, value: param.value === "true" } };
            if (param.type === "DATE") return { ...param, value: null, typedValue: { kind: "date" as const, value: param.value ?? "" } };
            if (param.type === "TIMESTAMP") return { ...param, value: null, typedValue: { kind: "timestamp" as const, value: param.value ?? "" } };
            if (param.type === "CLOB") return { ...param, value: null, typedValue: { kind: "clob" as const, value: param.value ?? "" } };
            if (param.type === "NCLOB") return { ...param, value: null, typedValue: { kind: "nclob" as const, value: param.value ?? "" } };
            if (param.type === "BINARY_FLOAT") return { ...param, value: null, typedValue: { kind: "binary_float" as const, value: param.value ?? "" } };
            if (param.type === "BINARY_DOUBLE") return { ...param, value: null, typedValue: { kind: "binary_double" as const, value: param.value ?? "" } };
            if (param.type === "NCHAR" || param.type === "NVARCHAR2" || param.type === "INTERVAL YEAR TO MONTH" || param.type === "INTERVAL DAY TO SECOND") return { ...param, value: null, typedValue: { kind: "text" as const, value: param.value ?? "" } };
            if (param.type === "BLOB") return { ...param, value: null, typedValue: { kind: "blob" as const, value: { encoding: "base64" as const, data: param.value ?? "" } } };
            if (param.type === "RAW") return { ...param, value: null, typedValue: { kind: "raw" as const, value: { encoding: "base64" as const, data: param.value ?? "" } } };
            if (canonicalPlDebugScalarType(param.type) === "TIMESTAMP WITH TIME ZONE" || canonicalPlDebugScalarType(param.type) === "TIMESTAMP WITH LOCAL TIME ZONE") return { ...param, value: null };
          }
          return { ...param };
        }),
      }),
}));
const previewError = computed(() => {
  if (props.loadError) return props.loadError;
  if (!props.preview || props.loading) return null;
  if (props.preview.capabilities.supported !== true) return String(props.preview.capabilities.reason || t("plDebug.launch.unsupported"));
  if (anonymous.value) return null;
  if (candidates.value.length === 0) return props.preview.targetPreview?.message || t("plDebug.start.metadataUnavailable");
  if (selected.value?.signature.status !== undefined && selected.value.signature.status !== "VALID") return t("plDebug.launch.invalidObject");
  if (selected.value?.parameterTransport === "not_implemented") return selected.value.message || t("plDebug.start.metadataUnavailable");
  return null;
});
const canStart = computed(
  () =>
    !starting.value &&
    !store.pendingStart &&
    !store.recoveryRequired &&
    !store.compilationBusy &&
    !(store.compilationRef?.connectionId === props.connectionId && store.compilationUnresolved) &&
    !props.loading &&
    !previewError.value &&
    !!props.preview?.connectionRevision &&
    props.preview.capabilities.supported === true &&
    riskAccepted.value &&
    (anonymous.value || (!!selected.value && editableParams.value.every(compositeComplete))),
);

async function recoverDebug() {
  if (starting.value) return;
  starting.value = true;
  errorMessage.value = null;
  const connectionId = props.connectionId;
  const database = props.database;
  const fingerprint = JSON.stringify(startRequest.value);
  try {
    const result = await store.recover();
    if (result && open.value && props.connectionId === connectionId && props.database === database && JSON.stringify(startRequest.value) === fingerprint) {
      open.value = false;
      emit("recover");
    }
  } catch (caught) {
    errorMessage.value = String(caught);
  } finally {
    starting.value = false;
  }
}

async function startDebug() {
  if (!canStart.value) return;
  starting.value = true;
  errorMessage.value = null;
  try {
    const request = JSON.parse(JSON.stringify(startRequest.value)) as PlDebugStartRequest;
    const connectionId = props.connectionId;
    const database = props.database;
    const revision = props.preview!.connectionRevision;
    const fingerprint = JSON.stringify(request);
    const isCurrent = () => open.value && riskAccepted.value && props.connectionId === connectionId && props.database === database && props.preview?.connectionRevision === revision && JSON.stringify(startRequest.value) === fingerprint;
    const result = await store.start(connectionId, database, request, { riskAccepted: true, expectedConnectionRevision: revision, isCurrent });
    if (isCurrent()) open.value = false;
    emit("started", result.debugId ?? "");
  } catch (caught) {
    errorMessage.value = String(caught);
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
      </DialogHeader>
      <div class="flex items-center gap-2">
        <select v-if="!anonymous" v-model="selectedIndex" class="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" :disabled="starting || loading" :aria-label="t('plDebug.start.signature')">
          <option value="" disabled>{{ t("plDebug.start.chooseSignature") }}</option>
          <option v-for="(candidate, index) in candidates" :key="`${candidate.signature.objectId}:${candidate.signature.subprogramId}`" :value="String(index)">
            {{ candidate.signature.schema }}.{{ candidate.signature.packageName ? `${candidate.signature.packageName}.` : "" }}{{ candidate.signature.objectName }}({{ candidate.parameters.map((param) => `${param.name} ${param.mode} ${argumentType(candidate.signature, param)}`).join(", ") }})
          </option>
        </select>
        <Button variant="outline" size="sm" :disabled="starting || loading" @click="emit('refresh')">{{ t("plDebug.start.refresh") }}</Button>
        <Button v-if="allowTypePreparation && selected?.signature.signatureVersion !== 2" variant="outline" size="sm" :disabled="starting || loading" @click="emit('prepareTypes')">{{ t("plDebug.start.prepareTypes") }}</Button>
      </div>
      <pre v-if="anonymous" class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 font-mono text-xs">{{ source }}</pre>
      <p v-if="selected?.returnValue" class="text-sm">
        {{ t("plDebug.start.returnType") }}: <span class="break-all font-mono">{{ argumentType(selected.signature, selected.returnValue) }}</span>
      </p>
      <div class="max-h-80 overflow-auto">
        <table class="w-full table-fixed text-xs">
          <thead class="text-left text-muted-foreground">
            <tr>
              <th class="w-20 px-2 py-1 font-normal">{{ t("plDebug.params.name") }}</th>
              <th class="w-16 px-2 py-1 font-normal">{{ t("plDebug.params.mode") }}</th>
              <th class="w-28 px-2 py-1 font-normal">{{ t("plDebug.params.type") }}</th>
              <th class="px-2 py-1 font-normal">{{ t("plDebug.params.value") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(param, index) in editableParams" :key="`${param.name}-${index}`" class="border-t">
              <td class="break-all px-2 py-1 align-top font-mono">{{ param.name }}</td>
              <td class="whitespace-nowrap px-2 py-1 align-top">{{ param.mode }}</td>
              <td class="max-w-36 px-2 py-1 align-top font-mono" :class="shapeFor(index) ? 'min-w-28 break-words' : ''" :title="selected ? argumentType(selected.signature, selected.parameters[index]!) : param.type">{{ shapeFor(index)?.reference?.typeName ?? param.type }}</td>
              <td class="min-w-0 px-2 py-1">
                <div v-if="param.mode !== 'OUT'" class="flex flex-wrap gap-1">
                  <select v-if="!shapeFor(index) || selected?.parameters[index]?.defaulted === 'Y'" v-model="param.inputState" class="h-8 rounded-md border bg-background px-1 text-sm" :disabled="starting" :aria-label="`${param.name}: ${t('plDebug.start.inputState')}`">
                    <option value="value">{{ t("plDebug.start.textValue") }}</option>
                    <option v-if="!shapeFor(index)" value="null">SQL NULL</option>
                    <option v-if="selected?.parameters[index]?.defaulted === 'Y'" value="default">{{ t("plDebug.start.defaultValue") }}</option>
                  </select>
                  <div v-if="param.inputState === 'value' && shapeFor(index) && selected && (param.typedValue?.kind === 'record' || param.typedValue?.kind === 'collection' || param.typedValue?.kind === 'object')" class="min-w-0 basis-full space-y-2 py-1">
                    <PlDebugCompositeEditor :model-value="param.typedValue" :signature="selected.signature" :shape="shapeFor(index)!" :label="param.name" :disabled="starting" @update:model-value="updateCompositeParam(param, $event)" />
                    <p v-if="!compositeComplete(param, index)" role="alert" class="text-sm text-destructive">{{ t("plDebug.start.compositeInvalid") }}</p>
                  </div>
                  <div v-else-if="param.inputState === 'value' && param.typedValue?.kind === 'timestamp_tz'" class="flex min-w-0 flex-1 flex-wrap gap-2">
                    <label class="min-w-48 flex-1 text-muted-foreground"
                      >{{ t("plDebug.start.localTime")
                      }}<Input :model-value="param.typedValue.value.local" class="mt-1 h-8 font-mono text-sm" :disabled="starting" :aria-label="`${param.name}: local`" placeholder="YYYY-MM-DDTHH:mm:ss.fffffffff" @update:model-value="updateTimezoneParam(param, 'local', $event)"
                    /></label>
                    <label class="w-24 text-muted-foreground"
                      >{{ t("plDebug.start.utcOffset") }}<Input :model-value="param.typedValue.value.offset" class="mt-1 h-8 font-mono text-sm" :disabled="starting" :aria-label="`${param.name}: offset`" placeholder="+00:00" @update:model-value="updateTimezoneParam(param, 'offset', $event)"
                    /></label>
                    <label class="min-w-40 flex-1 text-muted-foreground"
                      >{{ t("plDebug.start.optionalRegion")
                      }}<Input :model-value="param.typedValue.value.region ?? ''" class="mt-1 h-8 font-mono text-sm" :disabled="starting" :aria-label="`${param.name}: region`" placeholder="America/New_York" @update:model-value="updateTimezoneParam(param, 'region', $event)"
                    /></label>
                  </div>
                  <Input
                    v-else-if="param.inputState === 'value' && param.typedValue?.kind === 'timestamp_ltz'"
                    :model-value="param.typedValue.value.instant"
                    class="h-8 min-w-48 flex-1 font-mono text-sm"
                    :disabled="starting"
                    :aria-label="`${param.name}: instant`"
                    placeholder="YYYY-MM-DDTHH:mm:ss.fffffffffZ"
                    @update:model-value="updateTimezoneParam(param, 'instant', $event)"
                  />
                  <select v-else-if="param.inputState === 'value' && param.type === 'PL/SQL BOOLEAN'" v-model="param.value" class="h-8 rounded-md border bg-background px-2 font-mono text-sm" :disabled="starting" :aria-label="param.name">
                    <option value="false">false</option>
                    <option value="true">true</option>
                  </select>
                  <label v-else-if="param.inputState === 'value' && (param.type === 'CLOB' || param.type === 'NCLOB' || param.type === 'BLOB' || param.type === 'RAW')" class="min-w-48 flex-1">
                    <span v-if="param.type === 'BLOB' || param.type === 'RAW'" class="text-muted-foreground">Base64</span>
                    <textarea
                      :value="param.value ?? ''"
                      rows="3"
                      class="w-full resize-y rounded-md border bg-background px-2 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      :disabled="starting"
                      :aria-label="param.type === 'BLOB' || param.type === 'RAW' ? `${param.name}: Base64` : param.name"
                      spellcheck="false"
                      autocapitalize="off"
                      @input="param.value = ($event.target as HTMLTextAreaElement).value"
                    />
                  </label>
                  <Input
                    v-else-if="param.inputState === 'value'"
                    :model-value="param.value ?? ''"
                    class="h-8 min-w-24 flex-1 font-mono text-sm"
                    :disabled="starting"
                    :aria-label="param.name"
                    :placeholder="
                      param.type === 'BINARY_FLOAT' ? 'IEEE 754 hex: 3F800000' : param.type === 'BINARY_DOUBLE' ? 'IEEE 754 hex: 3FF0000000000000' : param.type === 'DATE' ? 'YYYY-MM-DDTHH:mm:ss' : param.type === 'TIMESTAMP' ? 'YYYY-MM-DDTHH:mm:ss.fffffffff' : t('plDebug.params.valuePlaceholder')
                    "
                    @update:model-value="param.value = String($event)"
                  />
                </div>
                <span v-else class="text-muted-foreground">OUT</span>
              </td>
            </tr>
            <tr v-if="loading && editableParams.length === 0">
              <td colspan="4" class="px-2 py-3 text-center text-muted-foreground"><Loader2 class="mr-1 inline h-3 w-3 animate-spin" />{{ t("plDebug.launch.loading") }}</td>
            </tr>
            <tr v-else-if="editableParams.length === 0 && (anonymous || selected)">
              <td colspan="4" class="px-2 py-3 text-center text-muted-foreground">{{ t("plDebug.params.empty") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="previewError" role="alert" class="text-sm text-destructive">{{ previewError }}</p>
      <slot name="compilation" />
      <p v-if="selected?.signature.typeBindings?.length" class="text-sm text-muted-foreground">{{ t("plDebug.start.compositeInitializerWarning") }}</p>
      <label class="flex items-start gap-2 text-sm"
        ><input v-model="riskAccepted" type="checkbox" class="mt-1" :disabled="starting || loading || !!previewError" /><span>{{ t("plDebug.start.riskAcknowledgement") }}</span></label
      >
      <p v-if="errorMessage" class="text-xs text-destructive">{{ errorMessage }}</p>
      <DialogFooter>
        <Button v-if="store.recoveryRequired || store.pendingStart" variant="outline" :disabled="starting" @click="recoverDebug">{{ t("plDebug.start.recover") }}</Button>
        <Button variant="outline" :disabled="starting" @click="open = false">
          {{ t("common.cancel") }}
        </Button>
        <Button :disabled="!canStart" @click="startDebug">
          <Loader2 v-if="starting" class="mr-1 h-4 w-4 animate-spin" />
          {{ t("plDebug.start.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
