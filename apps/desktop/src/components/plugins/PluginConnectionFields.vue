<script setup lang="ts">
import { computed } from "vue";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { PluginConnectionProviderContribution, PluginFormField, PluginFormFieldBinding, PluginFormFieldValue } from "@/types/database";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

const props = defineProps<{
  contribution: PluginConnectionProviderContribution;
  modelValue: Record<string, PluginFormFieldValue>;
  hiddenBindings?: PluginFormFieldBinding[];
  layout?: "stacked" | "connection-dialog";
}>();

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, PluginFormFieldValue>];
}>();

const formValues = computed(() => props.modelValue);
const visibleFields = computed(() =>
  props.contribution.fields.filter((field) => {
    if (field.binding && props.hiddenBindings?.includes(field.binding)) return false;
    if (!field.visible_when) return true;
    const source = props.contribution.fields.find((candidate) => candidate.key === field.visible_when?.field);
    const value = formValues.value[field.visible_when.field] ?? source?.default;
    return field.visible_when.one_of.some((candidate) => candidate === value);
  }),
);
const isConnectionDialogLayout = computed(() => props.layout === "connection-dialog");

function fieldValue(field: PluginFormField): PluginFormFieldValue {
  return formValues.value[field.key] ?? field.default ?? defaultValueFor(field);
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

function fieldRequired(field: PluginFormField): boolean {
  if (field.required) return true;
  if (!field.required_when) return false;
  const source = props.contribution.fields.find((candidate) => candidate.key === field.required_when?.field);
  const value = formValues.value[field.required_when.field] ?? source?.default;
  return field.required_when.one_of.some((candidate) => candidate === value);
}

async function browsePath(field: PluginFormField) {
  if (!isTauriRuntime()) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: false });
  if (typeof selected === "string") updateField(field, selected);
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
        <Input v-if="field.type === 'text' || field.type === 'number'" :id="fieldId(field)" :type="field.type === 'number' ? 'number' : 'text'" :model-value="fieldValue(field) as string | number | undefined" :placeholder="field.placeholder" @update:model-value="updateTextField(field, $event)" />
        <div v-else-if="field.type === 'path'" class="flex items-center gap-1">
          <Input :id="fieldId(field)" class="min-w-0 flex-1" :model-value="String(fieldValue(field) ?? '')" :placeholder="field.placeholder" @update:model-value="updateField(field, String($event))" />
          <button v-if="isTauriRuntime()" type="button" class="inline-flex h-9 shrink-0 items-center rounded-md border border-input bg-background px-3 text-xs hover:bg-accent" @click="browsePath(field)">…</button>
        </div>
        <PasswordInput v-else-if="field.type === 'password'" :id="fieldId(field)" :model-value="String(fieldValue(field) ?? '')" :placeholder="field.placeholder" @update:model-value="updateField(field, $event)" />
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
        <div v-if="field.description" class="text-[11px] leading-5 text-muted-foreground">{{ field.description }}</div>
      </div>
    </div>
  </div>
</template>
