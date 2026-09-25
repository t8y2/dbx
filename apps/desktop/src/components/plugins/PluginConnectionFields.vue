<script setup lang="ts">
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
import { pluginFieldIsRequired, pluginFieldIsVisible, type PluginFieldResolver } from "@/lib/plugins/pluginFieldConditions";
import { pickPluginFieldFile } from "@/lib/plugins/pluginFieldPicker";
import { invokePlugin, listLocalSshKeys } from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { LocalSshKey, PluginConnectionProviderContribution, PluginFormField, PluginFormFieldBinding, PluginFormFieldOption, PluginFormFieldValue } from "@/types/database";

const props = defineProps<{
  contribution: PluginConnectionProviderContribution;
  modelValue: Record<string, PluginFormFieldValue>;
  hiddenBindings?: PluginFormFieldBinding[];
  layout?: "stacked" | "connection-dialog";
  pluginId?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, PluginFormFieldValue>];
}>();

const { t } = useI18n();
const { toast } = useToast();

const formValues = computed(() => props.modelValue);
/** Value of any sibling field by key (condition evaluation reads current form values). */
function readFieldValue(key: string): PluginFormFieldValue {
  const field = props.contribution.fields.find((candidate) => candidate.key === key);
  return field ? (formValues.value[key] ?? field.default ?? undefined) : undefined;
}
const resolveSiblingField: PluginFieldResolver = (key) => props.contribution.fields.find((candidate) => candidate.key === key);
function fieldVisible(field: PluginFormField): boolean {
  if (field.binding && props.hiddenBindings?.includes(field.binding)) return false;
  return pluginFieldIsVisible(field, readFieldValue, resolveSiblingField);
}
function fieldRequired(field: PluginFormField): boolean {
  return pluginFieldIsRequired(field, readFieldValue);
}
const visibleFields = computed(() => props.contribution.fields.filter((field) => fieldVisible(field)));
const isConnectionDialogLayout = computed(() => props.layout === "connection-dialog");

function fieldValue(field: PluginFormField): PluginFormFieldValue {
  // `null` is "unset": hosts used to hydrate untouched fields with a null
  // default, and a null reaching an input must not look like a stored value.
  const raw = formValues.value[field.key];
  const value = raw ?? field.default ?? defaultValueFor(field);
  return value === null ? undefined : value;
}

/** Text/number inputs render any primitive as text; `null` stays empty. */
function fieldInputValue(field: PluginFormField): string | number {
  const value = fieldValue(field);
  if (typeof value === "boolean") return String(value);
  return value ?? "";
}

function updateField(field: PluginFormField, value: PluginFormFieldValue) {
  emit("update:modelValue", { ...formValues.value, [field.key]: value });
}

function updateTextField(field: PluginFormField, value: string | number) {
  if (field.type === "number") {
    updateField(field, value === "" ? undefined : Number(value));
    return;
  }
  updateField(field, String(value));
}

function updateBooleanField(field: PluginFormField, value: boolean) {
  updateField(field, value);
}

function updateSelectField(field: PluginFormField, value: unknown) {
  if (value === null || value === undefined) {
    updateField(field, undefined);
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") updateField(field, value);
}

function fieldId(field: PluginFormField): string {
  return `${props.contribution.id}-${field.key}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function defaultValueFor(field: PluginFormField): PluginFormFieldValue {
  if (field.type === "boolean") return false;
  if (field.type === "number") return undefined;
  return "";
}

// ---------------------------------------------------------------------------
// Dynamic option lists (fields declaring `options_action`)
// ---------------------------------------------------------------------------

// A field may point `options_action` at a plugin method returning
// `{ options: [{ value, label }] }`. The host fetches it once per dialog and
// renders the field as a select; a missing plugin id, a failed call, or an
// empty result falls back to the declared text input (older hosts without
// this extension never fetch and simply keep the text field).
const dynamicOptions = ref<Record<string, PluginFormFieldOption[]>>({});
const dynamicOptionsRequested = ref(new Set<string>());

const optionsActionFields = computed(() => visibleFields.value.filter((field) => field.options_action));

watch(
  optionsActionFields,
  (fields) => {
    for (const field of fields) {
      const action = field.options_action;
      if (!action || !props.pluginId || dynamicOptionsRequested.value.has(field.key)) continue;
      dynamicOptionsRequested.value.add(field.key);
      invokePlugin<{ options?: PluginFormFieldOption[] }>(props.pluginId, action)
        .then((result) => {
          const options = Array.isArray(result?.options) ? result.options.filter((option) => option && option.value !== undefined) : [];
          dynamicOptions.value = { ...dynamicOptions.value, [field.key]: options };
        })
        .catch(() => {
          dynamicOptions.value = { ...dynamicOptions.value, [field.key]: [] };
        });
    }
  },
  { immediate: true },
);

function selectOptionsFor(field: PluginFormField): PluginFormFieldOption[] | null {
  if (!field.options_action) return null;
  const options = dynamicOptions.value[field.key];
  if (!options || options.length === 0) return null;
  // Keep a stored value visible even when its profile disappeared so the
  // dialog does not silently look "unset" on reopen.
  const current = fieldValue(field);
  if (current !== undefined && current !== "" && !options.some((option) => String(option.value) === String(current))) {
    return [{ value: String(current), label: String(current) }, ...options];
  }
  return options;
}

// ---------------------------------------------------------------------------
// Local SSH key suggestions (Host API: private_key_path convenience picker)
// ---------------------------------------------------------------------------

const LOCAL_SSH_KEY_FIELD = "private_key_path";

function isLocalSshKeyField(field: PluginFormField): boolean {
  return field.key === LOCAL_SSH_KEY_FIELD && (field.type === "text" || field.type === "password");
}

const hasLocalSshKeyField = computed(() => visibleFields.value.some((field) => isLocalSshKeyField(field)));

const localSshKeys = ref<LocalSshKey[]>([]);
const localSshKeysRequested = ref(false);

async function loadLocalSshKeys() {
  if (localSshKeysRequested.value) return;
  localSshKeysRequested.value = true;
  try {
    localSshKeys.value = await listLocalSshKeys();
  } catch {
    localSshKeys.value = [];
  }
}

watch(
  hasLocalSshKeyField,
  (present) => {
    if (present) void loadLocalSshKeys();
  },
  { immediate: true },
);

function localSshKeyFile(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() || path;
}

function localSshKeyLabel(key: LocalSshKey): string {
  const algorithm = key.algorithm || "?";
  return key.hasPassphrase ? `${localSshKeyFile(key.path)} · ${algorithm} · ${t("connection.pluginSshKeyEncrypted")}` : `${localSshKeyFile(key.path)} · ${algorithm}`;
}

function applyLocalSshKey(field: PluginFormField, event: Event) {
  const select = event.target as HTMLSelectElement;
  const selected = localSshKeys.value.find((key) => key.path === select.value);
  select.value = "";
  if (!selected) return;
  pickPluginFieldPath(field, selected.path);
}

// ---------------------------------------------------------------------------
// Manifest-declared local file action (`picker`, Host API 1.1)
// ---------------------------------------------------------------------------

/** Fields whose picker acts on the working copy; the plugin reads the file. */
function pickerField(field: PluginFormField) {
  return field.picker;
}

/**
 * Browser hosts cannot hand a path to the plugin, so the picker uploads the
 * file content into the declared `content_field` instead. A picker without a
 * `content_field` is desktop-only and stays hidden in the browser.
 */
function pickerVisible(field: PluginFormField): boolean {
  const picker = pickerField(field);
  if (!picker) return false;
  if (isTauriRuntime()) return true;
  return picker.kind === "file" && Boolean(picker.content_field);
}

const pickerBusyField = ref<string | null>(null);

function pickerLabelKey(field: PluginFormField): string {
  const picker = pickerField(field);
  if (picker?.kind === "directory") return isTauriRuntime() ? "connection.pluginFieldSelectDirectory" : "connection.pluginFieldSelectFile";
  return isTauriRuntime() ? "connection.pluginFieldSelectFile" : "connection.pluginFieldUploadFile";
}

/** Path selection (desktop) and the SSH key dropdown share this entry point. */
function pickPluginFieldPath(field: PluginFormField, path: string) {
  const picker = pickerField(field);
  const next = { ...formValues.value, [field.key]: path };
  // The plugin treats content as more specific than a path, so selecting a path
  // must clear the uploaded copy — otherwise a stale upload keeps winning.
  if (picker?.content_field) delete next[picker.content_field];
  emit("update:modelValue", next);
}

/** Upload content into the paired field and clear the (meaningless) path. */
function pickPluginFieldContent(field: PluginFormField, contentKey: string, content: string) {
  const next = { ...formValues.value, [contentKey]: content };
  delete next[field.key];
  emit("update:modelValue", next);
}

async function runPluginFieldPicker(field: PluginFormField) {
  const picker = pickerField(field);
  if (!picker || pickerBusyField.value) return;
  pickerBusyField.value = field.key;
  try {
    const picked = await pickPluginFieldFile(picker);
    if (!picked) return;
    if (picked.path !== undefined) {
      pickPluginFieldPath(field, picked.path);
      return;
    }
    if (picked.content !== undefined && picker.content_field) {
      pickPluginFieldContent(field, picker.content_field, picked.content);
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  } finally {
    pickerBusyField.value = null;
  }
}
</script>

<template>
  <div :class="isConnectionDialogLayout ? 'contents' : 'space-y-4'">
    <div v-if="!isConnectionDialogLayout && (contribution.label || contribution.description)" class="space-y-1">
      <div v-if="contribution.label" class="text-sm font-medium">{{ contribution.label }}</div>
      <div v-if="contribution.description" class="text-xs text-muted-foreground">{{ contribution.description }}</div>
    </div>
    <div v-else-if="isConnectionDialogLayout && contribution.description" class="col-span-full grid grid-cols-4 items-start gap-4">
      <span />
      <p class="col-span-3 m-0 text-xs leading-5 text-muted-foreground">{{ contribution.description }}</p>
    </div>

    <div v-for="field in visibleFields" :key="field.key" :class="isConnectionDialogLayout ? 'col-span-full grid grid-cols-4 items-start gap-4' : 'space-y-1.5'">
      <Label :for="fieldId(field)" :class="isConnectionDialogLayout ? 'justify-self-start pt-2 text-left' : 'text-xs'">
        {{ field.label }}
        <span v-if="fieldRequired(field)" class="text-destructive">*</span>
      </Label>
      <div :class="isConnectionDialogLayout ? 'col-span-3 min-w-0 space-y-1.5' : ''">
        <template v-if="field.type === 'text' || field.type === 'number'">
          <Select v-if="field.type === 'text' && selectOptionsFor(field)" :model-value="String(fieldValue(field) ?? '')" @update:model-value="updateSelectField(field, $event)">
            <SelectTrigger :id="fieldId(field)" :class="isConnectionDialogLayout ? 'h-9' : 'h-8 text-xs'">
              <SelectValue :placeholder="field.placeholder" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in selectOptionsFor(field)!" :key="String(option.value)" :value="String(option.value)">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
          <div v-else-if="isLocalSshKeyField(field)" class="flex items-center gap-1.5">
            <Input :id="fieldId(field)" type="text" :model-value="fieldInputValue(field)" :placeholder="field.placeholder" class="min-w-0 flex-1" @update:model-value="updateTextField(field, $event)" />
            <select
              class="h-9 w-40 shrink-0 rounded-md border border-input bg-transparent px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="localSshKeys.length === 0"
              :title="t('connection.pluginSshKeyPickerPlaceholder')"
              :aria-label="t('connection.pluginSshKeyPickerPlaceholder')"
              @change="applyLocalSshKey(field, $event)"
            >
              <option value="" disabled selected>{{ localSshKeys.length ? t("connection.pluginSshKeyPickerPlaceholder") : t("connection.pluginSshKeyPickerEmpty") }}</option>
              <option v-for="key in localSshKeys" :key="key.path" :value="key.path" :title="key.path">{{ localSshKeyLabel(key) }}</option>
            </select>
          </div>
          <Input v-else :id="fieldId(field)" :type="field.type === 'number' ? 'number' : 'text'" :model-value="fieldInputValue(field)" :placeholder="field.placeholder" @update:model-value="updateTextField(field, $event)" />
        </template>
        <PasswordInput v-else-if="field.type === 'password'" :id="fieldId(field)" :model-value="String(fieldValue(field) ?? '')" :placeholder="field.placeholder" @update:model-value="updateField(field, $event)" />
        <PasswordTextarea v-else-if="field.type === 'textarea' && field.binding === 'secret'" :id="fieldId(field)" :model-value="String(fieldValue(field) ?? '')" :placeholder="field.placeholder" @update:model-value="updateField(field, $event)" />
        <textarea
          v-else-if="field.type === 'textarea'"
          :id="fieldId(field)"
          :value="String(fieldValue(field) ?? '')"
          :placeholder="field.placeholder"
          class="min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          @input="updateField(field, ($event.target as HTMLTextAreaElement).value)"
        />
        <Select v-else-if="field.type === 'select'" :model-value="String(fieldValue(field) ?? '')" @update:model-value="updateSelectField(field, $event)">
          <SelectTrigger :id="fieldId(field)" :class="isConnectionDialogLayout ? 'h-9' : 'h-8 text-xs'">
            <SelectValue :placeholder="field.placeholder" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in field.options || []" :key="option.value" :value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <div v-else-if="field.type === 'boolean'" class="flex h-9 items-center">
          <Switch :id="fieldId(field)" :model-value="Boolean(fieldValue(field))" size="sm" @update:model-value="updateBooleanField(field, $event)" />
        </div>
        <div v-if="pickerVisible(field)" class="flex items-center gap-2">
          <Button :id="`${fieldId(field)}-picker`" variant="outline" size="sm" class="h-8 gap-1.5 text-xs" :disabled="pickerBusyField === field.key" @click="runPluginFieldPicker(field)">
            <FolderOpen class="size-3.5" aria-hidden="true" />
            {{ t(pickerLabelKey(field)) }}
          </Button>
        </div>
        <div v-if="field.description" class="text-[11px] leading-5 text-muted-foreground">{{ field.description }}</div>
      </div>
    </div>
  </div>
</template>
