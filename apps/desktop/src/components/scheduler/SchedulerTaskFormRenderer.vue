<script setup lang="ts">
// Dynamic provider config form. Fields are manifest `PluginFormField`
// declarations (ADR §6.1); visibility/required evaluation reuses the shared
// plugin condition engine, so this is the same field system the connection
// dialogs render — never a scheduler-specific dialect.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpen } from "@lucide/vue";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import PasswordTextarea from "@/components/ui/PasswordTextarea.vue";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/composables/useToast";
import { invokePlugin } from "@/lib/backend/api";
import { pickPluginFieldFile } from "@/lib/plugins/pluginFieldPicker";
import { configFromFormValues, formFieldRequired, visibleFormFields, type SchedulerFormValues } from "@/lib/scheduler/schedulerForm";
import type { ConnectionConfig, PluginFormField, PluginFormFieldOption, PluginFormFieldValue } from "@/types/database";
import PluginPathPickerDialog from "@/components/plugins/PluginPathPickerDialog.vue";

const props = defineProps<{
  fields: readonly PluginFormField[];
  modelValue: SchedulerFormValues;
  disabled?: boolean;
  /**
   * Connections the selected provider accepts (the editor's filtered list).
   * Feeds the host-reserved `host/connections` options_action; passing nothing
   * simply falls those fields back to their declared text input.
   */
  connections?: readonly ConnectionConfig[];
  /** Owning plugin id, for task fields declaring a plugin-side options_action. */
  pluginId?: string;
  /**
   * The task's bound primary connection id (`target.connectionId`). Last link
   * of a plugin directory picker's fallback chain: declared sibling fields
   * first, then the task connection.
   */
  taskConnectionId?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: SchedulerFormValues];
}>();

const { t, locale } = useI18n();
const { toast } = useToast();

const shownFields = computed(() => visibleFormFields(props.fields, props.modelValue));

function fieldValue(field: PluginFormField): PluginFormFieldValue {
  const raw = props.modelValue[field.key];
  const value = raw ?? field.default ?? undefined;
  return value === null ? undefined : value;
}

function fieldInputValue(field: PluginFormField): string | number {
  const value = fieldValue(field);
  return typeof value === "boolean" ? String(value) : (value ?? "");
}

function updateField(field: PluginFormField, value: PluginFormFieldValue) {
  emit("update:modelValue", { ...props.modelValue, [field.key]: value });
}

function updateTextField(field: PluginFormField, value: string | number) {
  if (field.type === "number") {
    updateField(field, value === "" ? undefined : Number(value));
    return;
  }
  updateField(field, String(value));
}

function fieldId(field: PluginFormField): string {
  return `scheduler-field-${field.key}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

const pickerBusyKey = ref("");

async function runPicker(field: PluginFormField) {
  if (!field.picker || pickerBusyKey.value) return;
  if (field.picker.source === "plugin") {
    openPluginPathPicker(field);
    return;
  }
  pickerBusyKey.value = field.key;
  try {
    const picked = await pickPluginFieldFile(field.picker);
    if (!picked) return;
    if (picked.path !== undefined) {
      updateField(field, picked.path);
      return;
    }
    if (picked.content !== undefined && field.picker.content_field) {
      emit("update:modelValue", { ...props.modelValue, [field.picker.content_field]: picked.content });
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  } finally {
    pickerBusyKey.value = "";
  }
}

// ---------------------------------------------------------------------------
// Plugin-backed directory pickers (`picker.source: "plugin"`)
// ---------------------------------------------------------------------------

// Same `picker` attribute as the local native action, but the dialog walks the
// plugin's own storage tree over the generic invokePlugin channel (same as
// options_action; the `task/*` scheduler namespace stays frozen). The
// connection id is resolved from the declared sibling chain — first non-empty
// sibling wins — and falls back to the task's bound connection; with none the
// browse button disables and the dialog explains what is missing.
const pluginPathPickerField = ref<PluginFormField | null>(null);

function pluginPickerConnectionKeys(field: PluginFormField): string[] {
  const raw = field.picker?.connection_field;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function pluginPickerConnectionId(field: PluginFormField): string {
  for (const key of pluginPickerConnectionKeys(field)) {
    const value = props.modelValue[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return (props.taskConnectionId ?? "").trim();
}

function openPluginPathPicker(field: PluginFormField) {
  pluginPathPickerField.value = field;
}

const pluginPathPickerOpen = computed({
  get: () => pluginPathPickerField.value !== null,
  set: (value: boolean) => {
    if (!value) pluginPathPickerField.value = null;
  },
});

function pluginPathPickerInitialPath(field: PluginFormField): string {
  const value = fieldValue(field);
  return typeof value === "string" ? value : "";
}

function applyPluginPathPicker(path: string) {
  const field = pluginPathPickerField.value;
  if (!field) return;
  updateField(field, path);
}

/** Persisted projection of the current values (secret-bound keys dropped). */
const persistedConfig = computed(() => configFromFormValues(props.fields, props.modelValue));
defineExpose({ persistedConfig });

// ---------------------------------------------------------------------------
// Dynamic option lists (fields declaring `options_action`)
// ---------------------------------------------------------------------------

// Same contract the connection dialogs render (PluginConnectionFields): the
// host fetches the options once per field and renders a select; an empty
// result, a failed call, or a missing plugin id falls back to the declared
// text input. `host/…` is the host-reserved self-service namespace (like
// `picker`): resolved locally from host state, never a plugin RPC —
// `host/connections` lists the saved connections the provider accepts.
const dynamicOptions = ref<Record<string, PluginFormFieldOption[]>>({});
const dynamicOptionsRequested = ref(new Set<string>());

const optionsActionFields = computed(() => shownFields.value.filter((field) => field.options_action));

function hostOptions(action: string): PluginFormFieldOption[] {
  if (action === "host/connections") return (props.connections ?? []).map((connection) => ({ value: connection.id, label: connection.name }));
  return [];
}

function resolveOptions(field: PluginFormField) {
  const action = field.options_action;
  if (!action || dynamicOptionsRequested.value.has(field.key)) return;
  dynamicOptionsRequested.value.add(field.key);
  if (action.startsWith("host/")) {
    dynamicOptions.value = { ...dynamicOptions.value, [field.key]: hostOptions(action) };
    return;
  }
  if (!props.pluginId) {
    dynamicOptions.value = { ...dynamicOptions.value, [field.key]: [] };
    return;
  }
  // locale lets the sidecar localize the returned option labels; older
  // sidecars ignore it. A failure degrades to the declared text input.
  invokePlugin<{ options?: PluginFormFieldOption[] }>(props.pluginId, action, { locale: locale.value })
    .then((result) => {
      const options = Array.isArray(result?.options) ? result.options.filter((option) => option && option.value !== undefined) : [];
      dynamicOptions.value = { ...dynamicOptions.value, [field.key]: options };
    })
    .catch(() => {
      dynamicOptions.value = { ...dynamicOptions.value, [field.key]: [] };
    });
}

watch(
  optionsActionFields,
  (fields) => {
    for (const field of fields) resolveOptions(field);
  },
  { immediate: true },
);

// reka-ui forbids a SelectItem with an empty-string value (empty means "show
// the placeholder"), so the empty entry rides a host-internal sentinel that
// updateSelectField maps back to "untouched". Connection ids are host uuids
// and can never collide with it. There is no host-wide reka-ui empty-select
// convention to follow (no other surface renders a clearable dynamic select),
// so the sentinel stays a private constant of this renderer — it is never
// persisted: updateSelectField maps it (and "" / null / undefined) to
// `undefined`, so the saved config omits the key entirely.
const EMPTY_SELECT_VALUE = "__dbx_empty__";

// Label chain for the empty entry of a may-stay-empty dynamic select: the
// manifest's declared `empty_label` wins (already localized by
// frontendPlugin), then the field's `placeholder` (the pre-`empty_label` way
// existing manifests named the semantics), then the host's own wording.
function emptyOptionLabel(field: PluginFormField): string {
  const declared = field.empty_label?.trim();
  if (declared) return declared;
  const placeholder = field.placeholder?.trim();
  if (placeholder) return placeholder;
  return t("scheduler.editor.emptyOption");
}

function selectOptionsFor(field: PluginFormField): PluginFormFieldOption[] | null {
  if (!field.options_action) return null;
  const options = dynamicOptions.value[field.key];
  if (!options || options.length === 0) return null;
  const merged = [...options];
  // Keep a stored value visible even when its connection disappeared so the
  // form does not silently look "unset" on reopen.
  const current = fieldValue(field);
  if (current !== undefined && current !== "" && !merged.some((option) => String(option.value) === String(current))) {
    merged.unshift({ value: String(current), label: String(current) });
  }
  // Optional fields always keep an empty entry (empty = follow the task /
  // source connection), labeled by the field's declared empty-label chain.
  if (!formFieldRequired(props.fields, props.modelValue, field)) {
    merged.unshift({ value: EMPTY_SELECT_VALUE, label: emptyOptionLabel(field) });
  }
  return merged;
}

function updateSelectField(field: PluginFormField, value: unknown) {
  // Picking the empty entry (or clearing) returns the field to "untouched" so
  // the saved config omits the key instead of persisting an empty id.
  const stored = value === EMPTY_SELECT_VALUE || value === "" || value === null || value === undefined ? undefined : (value as PluginFormFieldValue);
  updateField(field, stored);
}

function isSecretTextarea(field: PluginFormField): boolean {
  return field.type === "textarea" && field.binding === "secret";
}
</script>

<template>
  <div class="space-y-4">
    <div v-for="field in shownFields" :key="field.key" class="space-y-1.5">
      <Label :for="fieldId(field)" class="text-xs">
        {{ field.label }}
        <span v-if="formFieldRequired(fields, modelValue, field)" class="text-destructive">*</span>
      </Label>
      <template v-if="field.type === 'text' && selectOptionsFor(field)">
        <Select :model-value="String(fieldValue(field) ?? '')" :disabled="disabled" @update:model-value="(value: unknown) => updateSelectField(field, value)">
          <SelectTrigger :id="fieldId(field)" class="h-8 text-xs"><SelectValue :placeholder="field.placeholder" /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in selectOptionsFor(field)!" :key="String(option.value)" :value="String(option.value)">{{ option.label }}</SelectItem>
          </SelectContent>
        </Select>
      </template>
      <template v-else-if="field.type === 'text' || field.type === 'number'">
        <div v-if="field.picker" class="flex items-center gap-1.5">
          <Input :id="fieldId(field)" type="text" :model-value="fieldInputValue(field)" :placeholder="field.placeholder" :disabled="disabled" class="min-w-0 flex-1" @update:model-value="updateTextField(field, $event)" />
          <Button variant="outline" size="sm" class="h-8 shrink-0 gap-1.5 text-xs" :disabled="disabled || (field.picker.source === 'plugin' && !pluginPickerConnectionId(field))" :data-scheduler-picker-plugin="field.picker.source === 'plugin' ? 'true' : undefined" @click="runPicker(field)">
            <FolderOpen class="size-3.5" aria-hidden="true" />
            {{ field.picker.kind === "directory" ? t("connection.pluginFieldSelectDirectory") : t("connection.pluginFieldSelectFile") }}
          </Button>
        </div>
        <Input v-else :id="fieldId(field)" :type="field.type === 'number' ? 'number' : 'text'" :model-value="fieldInputValue(field)" :placeholder="field.placeholder" :disabled="disabled" @update:model-value="updateTextField(field, $event)" />
      </template>
      <PasswordInput v-else-if="field.type === 'password'" :id="fieldId(field)" :model-value="String(fieldValue(field) ?? '')" :placeholder="field.placeholder" :disabled="disabled" @update:model-value="updateField(field, $event)" />
      <PasswordTextarea v-else-if="isSecretTextarea(field)" :id="fieldId(field)" :model-value="String(fieldValue(field) ?? '')" :placeholder="field.placeholder" :disabled="disabled" @update:model-value="updateField(field, $event)" />
      <textarea
        v-else-if="field.type === 'textarea'"
        :id="fieldId(field)"
        :value="String(fieldValue(field) ?? '')"
        :placeholder="field.placeholder"
        :disabled="disabled"
        class="min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        @input="updateField(field, ($event.target as HTMLTextAreaElement).value)"
      />
      <Select v-else-if="field.type === 'select'" :model-value="String(fieldValue(field) ?? '')" :disabled="disabled" @update:model-value="(value: unknown) => updateField(field, (value ?? undefined) as PluginFormFieldValue)">
        <SelectTrigger :id="fieldId(field)" class="h-8 text-xs"><SelectValue :placeholder="field.placeholder" /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="option in field.options || []" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
        </SelectContent>
      </Select>
      <div v-else-if="field.type === 'boolean'" class="flex h-8 items-center">
        <Switch :id="fieldId(field)" :model-value="Boolean(fieldValue(field))" :disabled="disabled" size="sm" @update:model-value="(value: boolean) => updateField(field, value)" />
      </div>
      <div v-if="field.description" class="text-[11px] leading-5 text-muted-foreground">{{ field.description }}</div>
      <p v-if="field.picker?.source === 'plugin' && !pluginPickerConnectionId(field)" class="text-[11px] leading-5 text-muted-foreground" :data-scheduler-picker-needs-connection="field.key">
        {{ t("pluginPathPicker.needsConnectionShort") }}
      </p>
    </div>
    <p v-if="shownFields.length === 0" class="text-xs text-muted-foreground">{{ t("scheduler.editor.noConfigFields") }}</p>
    <PluginPathPickerDialog
      v-if="pluginPathPickerField"
      v-model:open="pluginPathPickerOpen"
      :plugin-id="pluginId"
      :action="pluginPathPickerField.picker?.action"
      :connection-id="pluginPickerConnectionId(pluginPathPickerField)"
      :initial-path="pluginPathPickerInitialPath(pluginPathPickerField)"
      @select="applyPluginPathPicker"
    />
  </div>
</template>
