<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PlDebugTargetSignature } from "@/lib/debug/plDebugProtocol";
import {
  compositeChildShape,
  compositeNode,
  compositeObjectTypes,
  normalizedCompositeReference,
  emptyCompositeValue,
  type CompositeShape,
  type CompositeValue,
  type CompositeTimezoneValue,
  type CompositeBinaryValue,
  type ObjectInput,
  type ObjectArgument,
  type CompositeReference,
} from "@/lib/debug/plDebugComposite";

const props = defineProps<{ modelValue: CompositeValue; signature: PlDebugTargetSignature; shape: CompositeShape; label: string; disabled?: boolean; depth?: number }>();
const emit = defineEmits<{ "update:modelValue": [value: CompositeValue] }>();
const { t } = useI18n();
const node = computed(() => compositeNode(props.signature, props.shape));
const fields = computed(() => (props.modelValue.kind === "record" ? props.modelValue.value : []));
const entries = computed(() => (props.modelValue.kind === "collection" ? (props.modelValue.value ?? []) : []));
const definition = computed(() => node.value?.collections[0]);
const collectionDraft = ref<Array<{ index: string; value: CompositeValue }>>([]);
const leafDraft = ref<string | boolean>("");
const timezoneDraft = ref<CompositeTimezoneValue>();
const binaryDraft = ref<CompositeBinaryValue>();
const objectDraft = ref<ObjectInput>();
const constructorDrafts = new Map<string, ObjectInput>();
const typeDrafts = new Map<string, ObjectInput>();
const argumentDrafts = new Map<string, CompositeValue>();
const objectInput = computed(() => (props.modelValue.kind === "object" ? props.modelValue.value : null));
const objectTypes = computed(() => compositeObjectTypes(props.signature, props.shape));
const actualObjectNode = computed(() => (objectInput.value ? compositeNode(props.signature, { reference: objectInput.value.type, type: "EXT" }) : node.value));
const constructors = computed(() => (actualObjectNode.value?.constructorCalls?.state === "resolved" ? actualObjectNode.value.constructorCalls.constructors : []));
const constructor = computed(() => constructors.value.find((item) => item.id === objectInput.value?.constructorId));
const typeKey = (reference: CompositeReference) => JSON.stringify([reference.owner, reference.packageName, reference.typeName]);
const constructorKey = (reference: CompositeReference, id: string) => JSON.stringify([typeKey(reference), id]);
const argumentKey = (reference: CompositeReference, id: string, name: string) => JSON.stringify([typeKey(reference), id, name]);
watch(
  () => props.modelValue,
  (value) => {
    if (value.kind === "collection" && value.value !== null) collectionDraft.value = value.value;
    if (value.kind === "blob" || value.kind === "raw") {
      if (value.value !== null) binaryDraft.value = value;
    } else if (value.kind === "timestamp_tz" || value.kind === "timestamp_ltz") {
      if (value.value !== null) timezoneDraft.value = value;
    } else if (typeof value.value === "string" || typeof value.value === "boolean") leafDraft.value = value.value;
    if (value.kind === "object" && value.value !== null) {
      objectDraft.value = value.value;
      typeDrafts.set(typeKey(value.value.type), value.value);
      if (value.value.constructorId) constructorDrafts.set(constructorKey(value.value.type, value.value.constructorId), value.value);
      for (const argument of value.value.arguments) if (argument.state === "value") argumentDrafts.set(argumentKey(value.value.type, value.value.constructorId, argument.name), argument.value);
    }
  },
  { immediate: true },
);
function setCollectionNull(isNull: boolean) {
  emit("update:modelValue", { kind: "collection", value: isNull ? null : collectionDraft.value });
}
function setObjectNull(isNull: boolean) {
  if (!node.value) return;
  const type = objectTypes.value.find((item) => typeKey(item.reference) === typeKey(node.value!.reference))?.reference ?? objectTypes.value[0]?.reference ?? node.value.reference;
  emit("update:modelValue", { kind: "object", value: isNull ? null : (objectDraft.value ?? { type: normalizedCompositeReference(type), constructorId: "", arguments: [] }) });
}
function selectObjectType(key: string) {
  const type = objectTypes.value.find((item) => typeKey(item.reference) === key);
  if (type) emit("update:modelValue", { kind: "object", value: typeDrafts.get(key) ?? { type: normalizedCompositeReference(type.reference), constructorId: "", arguments: [] } });
}
function selectConstructor(id: string) {
  const selected = constructors.value.find((item) => item.id === id);
  if (!actualObjectNode.value || !selected) return;
  emit("update:modelValue", {
    kind: "object",
    value: constructorDrafts.get(constructorKey(actualObjectNode.value.reference, id)) ?? {
      type: normalizedCompositeReference(actualObjectNode.value.reference),
      constructorId: id,
      arguments: selected.parameters.map((formal): ObjectArgument => (formal.defaulted ? { name: formal.name, state: "default" } : { name: formal.name, state: "value", value: emptyCompositeValue(props.signature, compositeChildShape(formal.type, "ATTR_TYPE_")) })),
    },
  });
}
function objectArgument(name: string) {
  return objectInput.value?.arguments.find((item) => item.name === name);
}
function objectArgumentValue(name: string) {
  const argument = objectArgument(name);
  return argument?.state === "value" ? argument.value : undefined;
}
function argumentNeedsReset(name: string, type: Record<string, string | null>) {
  const value = objectArgumentValue(name);
  const shape = compositeChildShape(type, "ATTR_TYPE_");
  return value && value.kind !== emptyCompositeValue(props.signature, shape).kind && !(shape.booleanAlternative && value.kind === "boolean");
}
function setObjectArgument(argument: ObjectArgument) {
  if (!objectInput.value) return;
  const arguments_ = objectInput.value.arguments.some((item) => item.name === argument.name) ? objectInput.value.arguments.map((item) => (item.name === argument.name ? argument : item)) : [...objectInput.value.arguments, argument];
  emit("update:modelValue", { kind: "object", value: { ...objectInput.value, arguments: arguments_ } });
}
function removeObjectArgument(name: string) {
  if (objectInput.value) emit("update:modelValue", { kind: "object", value: { ...objectInput.value, arguments: objectInput.value.arguments.filter((item) => item.name !== name) } });
}
function setArgumentDefault(name: string, useDefault: boolean) {
  const formal = constructor.value?.parameters.find((item) => item.name === name);
  if (!formal) return;
  if (!objectInput.value) return;
  setObjectArgument(useDefault ? { name, state: "default" } : { name, state: "value", value: argumentDrafts.get(argumentKey(objectInput.value.type, constructor.value!.id, name)) ?? emptyCompositeValue(props.signature, compositeChildShape(formal.type, "ATTR_TYPE_")) });
}
const fieldValue = (name: string) => fields.value.find((field) => field.name === name)?.value;
function setField(name: string, value: CompositeValue | undefined) {
  const others = fields.value.filter((field) => field.name !== name);
  emit("update:modelValue", { kind: "record", value: value ? [...others, { name, value }] : others });
}
function setEntry(index: number, change: Partial<{ index: string; value: CompositeValue }>) {
  emit("update:modelValue", { kind: "collection", value: entries.value.map((entry, current) => (current === index ? { ...entry, ...change } : entry)) });
}
function addEntry() {
  if (!definition.value || entries.value.length >= 8192) return;
  const index = definition.value.INDEX_BY === "VARCHAR2" ? "" : String(entries.value.reduce((maximum, entry) => (/^[1-9][0-9]{0,3}$/.test(entry.index) ? Math.max(maximum, Number(entry.index)) : maximum), 0) + 1);
  emit("update:modelValue", { kind: "collection", value: [...entries.value, { index, value: emptyCompositeValue(props.signature, compositeChildShape(definition.value, "ELEM_TYPE_")) }] });
}
function setLeaf(value: string | boolean | null) {
  if (props.modelValue.kind === "blob" || props.modelValue.kind === "raw") {
    emit("update:modelValue", { kind: props.modelValue.kind, value: value === null ? null : binaryDraft.value?.kind === props.modelValue.kind ? binaryDraft.value.value : { encoding: "base64", data: "" } });
    return;
  }
  if (props.modelValue.kind === "timestamp_tz" || props.modelValue.kind === "timestamp_ltz") {
    if (value === null) emit("update:modelValue", props.modelValue.kind === "timestamp_tz" ? { kind: "timestamp_tz", value: null } : { kind: "timestamp_ltz", value: null });
    else emit("update:modelValue", timezoneDraft.value?.kind === props.modelValue.kind ? timezoneDraft.value : emptyCompositeValue(props.signature, props.shape));
    return;
  }
  if (value !== null) leafDraft.value = value;
  if (props.modelValue.kind === "boolean") emit("update:modelValue", { kind: "boolean", value: value === null ? null : value === true || value === "true" });
  else if (props.modelValue.kind !== "record" && props.modelValue.kind !== "collection" && props.modelValue.kind !== "object") emit("update:modelValue", { kind: props.modelValue.kind, value: value === null ? null : String(value) });
}

function updateTimezone(field: "local" | "offset" | "region" | "instant", value: string | number) {
  const current = props.modelValue;
  if (current.kind === "timestamp_tz" && current.value !== null && field !== "instant") emit("update:modelValue", { kind: current.kind, value: { ...current.value, [field]: field === "region" ? String(value) || null : String(value) } });
  if (current.kind === "timestamp_ltz" && current.value !== null && field === "instant") emit("update:modelValue", { kind: current.kind, value: { instant: String(value) } });
}
function updateBinary(value: string) {
  if (props.modelValue.kind === "blob" || props.modelValue.kind === "raw") emit("update:modelValue", { kind: props.modelValue.kind, value: { encoding: "base64", data: value } });
}
</script>

<template>
  <div class="min-w-0 space-y-2 text-sm">
    <template v-if="modelValue.kind === 'object' && node && (depth ?? 0) < 16">
      <label class="flex items-center gap-2"><input type="checkbox" :checked="modelValue.value === null" :disabled="disabled" :aria-label="`${label}: SQL NULL`" @change="setObjectNull(($event.target as HTMLInputElement).checked)" />SQL NULL</label>
      <template v-if="objectInput">
        <label v-if="objectTypes.length > 1 || (objectTypes.length === 1 && typeKey(objectTypes[0]!.reference) !== typeKey(objectInput.type))" class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="shrink-0 text-muted-foreground">{{ t("plDebug.params.type") }}</span>
          <select class="h-8 min-w-0 max-w-full flex-1 rounded-md border bg-background px-2 font-mono" :value="typeKey(objectInput.type)" :disabled="disabled" :aria-label="`${label}: ${t('plDebug.params.type')}`" @change="selectObjectType(($event.target as HTMLSelectElement).value)">
            <option v-for="item in objectTypes" :key="typeKey(item.reference)" :value="typeKey(item.reference)">{{ item.reference.owner }}.{{ item.reference.typeName }}</option>
          </select>
        </label>
        <label class="flex min-w-0 flex-wrap items-center gap-2">
          <span class="shrink-0 text-muted-foreground">{{ t("plDebug.start.compositeConstructor") }}</span>
          <select class="h-8 min-w-0 max-w-full flex-1 rounded-md border bg-background px-2 font-mono" :value="objectInput.constructorId" :disabled="disabled" :aria-label="`${label}: ${t('plDebug.start.compositeConstructor')}`" @change="selectConstructor(($event.target as HTMLSelectElement).value)">
            <option value="" disabled>{{ t("plDebug.start.compositeChooseConstructor") }}</option>
            <option v-for="item in constructors" :key="item.id" :value="item.id">{{ actualObjectNode?.reference.typeName }}({{ item.parameters.map((formal) => `${formal.name} ${formal.type.ATTR_TYPE_NAME}`).join(", ") }})</option>
          </select>
        </label>
        <p v-if="constructors.length === 0" class="text-sm text-muted-foreground">{{ t("plDebug.start.metadataUnavailable") }}</p>
        <div v-for="formal in constructor?.parameters ?? []" :key="formal.name" class="space-y-2 border-l-2 border-muted pl-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="break-all font-mono">{{ formal.name }}</span>
            <Button
              v-if="argumentNeedsReset(formal.name, formal.type)"
              variant="outline"
              size="sm"
              :disabled="disabled"
              :aria-label="`${label}.${formal.name}: ${t('common.clear')}`"
              @click="setObjectArgument({ name: formal.name, state: 'value', value: emptyCompositeValue(signature, compositeChildShape(formal.type, 'ATTR_TYPE_')) })"
              >{{ t("common.clear") }}</Button
            >
            <label v-if="formal.defaulted" class="flex items-center gap-2 text-muted-foreground"
              ><input type="checkbox" :checked="objectArgument(formal.name)?.state === 'default'" :disabled="disabled" :aria-label="`${label}.${formal.name}: ${t('plDebug.start.defaultValue')}`" @change="setArgumentDefault(formal.name, ($event.target as HTMLInputElement).checked)" />{{
                t("plDebug.start.defaultValue")
              }}</label
            >
          </div>
          <PlDebugCompositeEditor
            v-if="!formal.defaulted || objectArgument(formal.name)?.state !== 'default'"
            :model-value="objectArgumentValue(formal.name) ?? emptyCompositeValue(signature, compositeChildShape(formal.type, 'ATTR_TYPE_'))"
            :signature="signature"
            :shape="compositeChildShape(formal.type, 'ATTR_TYPE_')"
            :label="`${label}.${formal.name}`"
            :disabled="disabled"
            :depth="(depth ?? 0) + 1"
            @update:model-value="setObjectArgument({ name: formal.name, state: 'value', value: $event })"
          />
        </div>
        <div v-for="argument in objectInput.arguments.filter((item) => constructor && !constructor.parameters.some((formal) => formal.name === item.name))" :key="argument.name" class="flex items-center justify-between gap-2 text-destructive">
          <span class="break-all font-mono">{{ argument.name }}</span
          ><Button variant="outline" size="sm" :disabled="disabled" @click="removeObjectArgument(argument.name)">{{ t("common.remove") }}</Button>
        </div>
      </template>
    </template>
    <template v-else-if="modelValue.kind === 'record' && node && (depth ?? 0) < 16">
      <div v-for="attribute in node.attributes" :key="attribute.ATTR_NAME!" class="border-l-2 border-muted pl-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="break-all font-mono">{{ attribute.ATTR_NAME }}</span>
          <label class="flex items-center gap-2 text-muted-foreground"
            ><input
              type="checkbox"
              :checked="!!fieldValue(attribute.ATTR_NAME!)"
              :disabled="disabled"
              :aria-label="`${label}.${attribute.ATTR_NAME}: ${t('plDebug.start.compositeSetField')}`"
              @change="setField(attribute.ATTR_NAME!, ($event.target as HTMLInputElement).checked ? emptyCompositeValue(signature, compositeChildShape(attribute, 'ATTR_TYPE_')) : undefined)"
            />{{ t("plDebug.start.compositeSetField") }}</label
          >
        </div>
        <PlDebugCompositeEditor
          v-if="fieldValue(attribute.ATTR_NAME!)"
          :model-value="fieldValue(attribute.ATTR_NAME!)!"
          :signature="signature"
          :shape="compositeChildShape(attribute, 'ATTR_TYPE_')"
          :label="`${label}.${attribute.ATTR_NAME}`"
          :disabled="disabled"
          :depth="(depth ?? 0) + 1"
          class="mt-2"
          @update:model-value="setField(attribute.ATTR_NAME!, $event)"
        />
        <span v-else class="text-xs text-muted-foreground">{{ t("plDebug.start.compositeKeepInitializer") }}</span>
      </div>
      <div v-for="field in fields.filter((field) => !node?.attributes.some((attribute) => attribute.ATTR_NAME === field.name))" :key="field.name" class="flex items-center justify-between gap-2 text-destructive">
        <span class="break-all font-mono">{{ field.name }}</span
        ><Button variant="outline" size="sm" :disabled="disabled" @click="setField(field.name, undefined)">{{ t("common.remove") }}</Button>
      </div>
    </template>
    <template v-else-if="modelValue.kind === 'collection' && definition && (depth ?? 0) < 16">
      <label v-if="!definition.INDEX_BY" class="flex items-center gap-2"><input type="checkbox" :checked="modelValue.value === null" :disabled="disabled" :aria-label="`${label}: SQL NULL`" @change="setCollectionNull(($event.target as HTMLInputElement).checked)" />SQL NULL</label>
      <template v-if="modelValue.value !== null">
        <div v-for="(entry, index) in entries" :key="index" class="space-y-2 border-l-2 border-muted pl-3">
          <div class="flex items-center gap-2">
            <label class="flex min-w-0 flex-1 items-center gap-2"
              ><span class="shrink-0 whitespace-nowrap text-muted-foreground">{{ t("plDebug.start.compositeIndex") }}</span
              ><Input :model-value="entry.index" class="h-8 min-w-0 font-mono" :disabled="disabled" :aria-label="`${label}[${index + 1}]: ${t('plDebug.start.compositeIndex')}`" @update:model-value="setEntry(index, { index: String($event) })" /></label
            ><Button variant="outline" size="sm" :disabled="disabled" :aria-label="`${label}[${index + 1}]: ${t('common.remove')}`" @click="emit('update:modelValue', { kind: 'collection', value: entries.filter((_, current) => current !== index) })">{{ t("common.remove") }}</Button>
          </div>
          <PlDebugCompositeEditor :model-value="entry.value" :signature="signature" :shape="compositeChildShape(definition, 'ELEM_TYPE_')" :label="`${label}[${entry.index}]`" :disabled="disabled" :depth="(depth ?? 0) + 1" @update:model-value="setEntry(index, { value: $event })" />
        </div>
        <p v-if="entries.length === 0" class="text-muted-foreground">{{ t("plDebug.start.compositeEmpty") }}</p>
        <Button variant="outline" size="sm" :disabled="disabled || entries.length >= 8192" @click="addEntry">{{ t("plDebug.start.compositeAddEntry") }}</Button>
      </template>
    </template>
    <div v-else-if="modelValue.kind !== 'record' && modelValue.kind !== 'collection' && modelValue.kind !== 'object'" class="flex flex-wrap items-center gap-2">
      <select
        v-if="shape.booleanAlternative"
        class="h-8 rounded-md border bg-background px-2"
        :value="modelValue.kind"
        :disabled="disabled"
        :aria-label="`${label}: ${t('plDebug.params.type')}`"
        @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value === 'boolean' ? { kind: 'boolean', value: false } : { kind: 'number', value: '' })"
      >
        <option value="number">NUMBER</option>
        <option value="boolean">BOOLEAN</option>
      </select>
      <label class="flex items-center gap-2"><input type="checkbox" :checked="modelValue.value === null" :disabled="disabled" :aria-label="`${label}: SQL NULL`" @change="setLeaf(($event.target as HTMLInputElement).checked ? null : leafDraft)" />SQL NULL</label>
      <label v-if="(modelValue.kind === 'blob' || modelValue.kind === 'raw') && modelValue.value !== null" class="min-w-48 flex-1 text-muted-foreground"
        >Base64<textarea
          :value="modelValue.value.data"
          rows="3"
          class="w-full resize-y rounded-md border bg-background px-2 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          :disabled="disabled"
          :aria-label="`${label}: Base64`"
          spellcheck="false"
          autocapitalize="off"
          @input="updateBinary(($event.target as HTMLTextAreaElement).value)"
        />
      </label>
      <template v-else-if="modelValue.kind === 'timestamp_tz' && modelValue.value !== null">
        <label class="min-w-48 flex-1 text-muted-foreground"
          >{{ t("plDebug.start.localTime") }}<Input :model-value="modelValue.value.local" class="h-8 font-mono" :disabled="disabled" :aria-label="`${label}: ${t('plDebug.start.localTime')}`" placeholder="YYYY-MM-DDTHH:mm:ss.fffffffff" @update:model-value="updateTimezone('local', $event)"
        /></label>
        <label class="text-muted-foreground"
          >{{ t("plDebug.start.utcOffset") }}<Input :model-value="modelValue.value.offset" class="h-8 w-24 font-mono" :disabled="disabled" :aria-label="`${label}: ${t('plDebug.start.utcOffset')}`" placeholder="+00:00" @update:model-value="updateTimezone('offset', $event)"
        /></label>
        <label class="min-w-40 flex-1 text-muted-foreground"
          >{{ t("plDebug.start.optionalRegion") }}<Input :model-value="modelValue.value.region ?? ''" class="h-8 font-mono" :disabled="disabled" :aria-label="`${label}: ${t('plDebug.start.optionalRegion')}`" @update:model-value="updateTimezone('region', $event)"
        /></label>
      </template>
      <Input
        v-else-if="modelValue.kind === 'timestamp_ltz' && modelValue.value !== null"
        :model-value="modelValue.value.instant"
        class="h-8 min-w-48 flex-1 font-mono"
        :disabled="disabled"
        :aria-label="label"
        placeholder="YYYY-MM-DDTHH:mm:ss.fffffffffZ"
        @update:model-value="updateTimezone('instant', $event)"
      />
      <select v-else-if="modelValue.kind === 'boolean' && modelValue.value !== null" class="h-8 rounded-md border bg-background px-2 font-mono" :value="String(modelValue.value)" :disabled="disabled" :aria-label="label" @change="setLeaf(($event.target as HTMLSelectElement).value)">
        <option value="false">false</option>
        <option value="true">true</option>
      </select>
      <textarea
        v-else-if="(modelValue.kind === 'clob' || modelValue.kind === 'nclob') && modelValue.value !== null"
        :value="modelValue.value"
        rows="3"
        class="w-full resize-y rounded-md border bg-background px-2 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        :disabled="disabled"
        :aria-label="label"
        spellcheck="false"
        autocapitalize="off"
        @input="setLeaf(($event.target as HTMLTextAreaElement).value)"
      />
      <Input
        v-else-if="modelValue.value !== null"
        :model-value="String(modelValue.value)"
        class="h-8 min-w-24 flex-1 font-mono"
        :disabled="disabled"
        :aria-label="label"
        :placeholder="modelValue.kind === 'binary_float' ? 'IEEE 754 hex: 3F800000' : modelValue.kind === 'binary_double' ? 'IEEE 754 hex: 3FF0000000000000' : undefined"
        @update:model-value="setLeaf(String($event))"
      />
    </div>
  </div>
</template>
