<script setup lang="ts">
// Dynamic provider config form. Fields are manifest `PluginFormField`
// declarations (ADR §6.1); visibility/required evaluation reuses the shared
// plugin condition engine, so this is the same field system the connection
// dialogs render — never a scheduler-specific dialect.
import { computed, ref } from "vue";
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
import { pickPluginFieldFile } from "@/lib/plugins/pluginFieldPicker";
import { configFromFormValues, formFieldRequired, visibleFormFields, type SchedulerFormValues } from "@/lib/scheduler/schedulerForm";
import type { PluginFormField, PluginFormFieldValue } from "@/types/database";

const props = defineProps<{
  fields: readonly PluginFormField[];
  modelValue: SchedulerFormValues;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: SchedulerFormValues];
}>();

const { t } = useI18n();
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

/** Persisted projection of the current values (secret-bound keys dropped). */
const persistedConfig = computed(() => configFromFormValues(props.fields, props.modelValue));
defineExpose({ persistedConfig });

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
      <template v-if="field.type === 'text' || field.type === 'number'">
        <div v-if="field.picker" class="flex items-center gap-1.5">
          <Input :id="fieldId(field)" type="text" :model-value="fieldInputValue(field)" :placeholder="field.placeholder" :disabled="disabled" class="min-w-0 flex-1" @update:model-value="updateTextField(field, $event)" />
          <Button variant="outline" size="sm" class="h-8 shrink-0 gap-1.5 text-xs" :disabled="disabled || pickerBusyKey === field.key" @click="runPicker(field)">
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
    </div>
    <p v-if="shownFields.length === 0" class="text-xs text-muted-foreground">{{ t("scheduler.editor.noConfigFields") }}</p>
  </div>
</template>
